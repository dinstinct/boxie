import {reportFailure} from '../support/reporting';
import {mergeSourceMemberships, type SyncedOutlook} from "./sync-v2-outlook";
import type { OrganizationActions } from "./organization-actions";
import type { ConversationDetail, ConversationIndex } from "../../contracts/conversations";
import type {
  AssistantStatus,
  ConversationAction,
  MailboxClient,
  MailboxSyncStatus,
  ModerationPolicy,
  PrivateAssistantTurn
} from "../mailbox-client";
import { getOutlookAccessToken } from "../onboarding/microsoft-browser";
import type { BrowserCanonicalMailbox, BrowserConversationPreference } from "./canonical-types";
import { BrowserCanonicalMailStore } from "./browser-canonical-mail-store";
import {
  projectBrowserConversations,
  type BrowserConversationProjectionResult
} from "./browser-conversation-projection";
import { BrowserOutlookGraphClient } from "./browser-outlook-graph-client";
import { BrowserOutlookSynchronizer } from "./browser-outlook-synchronizer";
import type { CanonicalCloudReplicator } from "./canonical-cloud-replication";
import { ensureBrowserStorageHealth } from "../storage/browser-storage-health";

const pollIntervalMs = 15 * 60_000;

export class BrowserMailboxClient implements MailboxClient {
  readonly kind = "browser" as const;
  private projection!: BrowserConversationProjectionResult;
  private syncPromise: Promise<MailboxSyncStatus> | null = null;
  private status: MailboxSyncStatus;
  private replicaPromise: Promise<void> | null = null;
  private replicaRerunRequested = false;
  private quotaRetryAt = 0;

  private constructor(
    private readonly store: BrowserCanonicalMailStore,
    private mailbox: BrowserCanonicalMailbox,
    private readonly vaultKey: Uint8Array,
    private readonly cloudReplicator?: CanonicalCloudReplicator,
    private readonly organizationActions?: OrganizationActions,
    private readonly sourceSync?: SyncedOutlook
  ) {
    const completed = [
      mailbox.cursors.inbox.lastCompletedAt,
      mailbox.cursors.sent_items.lastCompletedAt
    ].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    this.status = {
      enabled: true,
      state: "idle",
      lastAttemptAt: completed,
      lastSuccessfulAt: completed,
      lastError: null,
      pollIntervalMs,
      ...(cloudReplicator
        ? {
            encryptedReplica: {
              state: "idle" as const,
              pendingCount: 0,
              lastSuccessfulAt: null,
              lastError: null
            }
          }
        : {})
    };
  }

  static async create(options: {
    store: BrowserCanonicalMailStore;
    mailbox: BrowserCanonicalMailbox;
    vaultKey: Uint8Array;
    cloudReplicator?: CanonicalCloudReplicator;
    organizationActions?: OrganizationActions;
    sourceSync?: SyncedOutlook;
  }): Promise<BrowserMailboxClient> {
    const client = new BrowserMailboxClient(
      options.store,
      options.mailbox,
      options.vaultKey,
      options.cloudReplicator,
      options.organizationActions,
      options.sourceSync
    );
    client.status = {
      ...client.status,
      localStorage: await ensureBrowserStorageHealth()
    };
    if (!options.cloudReplicator && client.status.localStorage?.warning) {
      client.status.localStorage.warning = client.status.localStorage.warning.replace("Encrypted backup remains available.", "Cloud backup is not enabled for this local inbox.");
    }
    await client.reproject();
    client.replicateEncryptedMailbox();
    return client;
  }

  async loadIndex(_signal?: AbortSignal): Promise<ConversationIndex> {
    return structuredClone(this.projection.index);
  }

  async loadDetail(conversationId: string, _signal?: AbortSignal): Promise<ConversationDetail> {
    const detail = this.projection.details.get(conversationId);
    if (!detail) throw new Error("This conversation is no longer available.");
    return structuredClone(detail);
  }

  async getSyncStatus(): Promise<MailboxSyncStatus> {
    return { ...this.status };
  }

  refresh(): Promise<MailboxSyncStatus> {
    if (Date.now() < this.quotaRetryAt) return Promise.resolve({...this.status});
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runRefresh().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  startBackgroundSync(): () => void {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - Date.parse(this.status.lastAttemptAt ?? "1970-01-01") >= pollIntervalMs) {
        void this.refresh().catch(() => undefined);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, pollIntervalMs);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }

  async getModerationPolicy(): Promise<ModerationPolicy> {
    return { junkRetentionDays: 30, trashRetentionDays: 30, outlookMutation: false };
  }

  async getAssistantStatus(): Promise<AssistantStatus | null> {
    return {
      provider: "cursor-acp",
      modelId: "browser-not-configured",
      modelName: "Boxie setup pending",
      available: false,
      hostedInference: true,
      privateToBoxie: true,
      outboundEmail: false,
      activation: "per_prompt"
    };
  }

  async listAssistantTurns(
    _conversationId: string,
    _signal?: AbortSignal
  ): Promise<PrivateAssistantTurn[]> {
    return [];
  }

  async askBoxie(_conversationId: string, _question: string): Promise<PrivateAssistantTurn> {
    throw new Error("Boxie’s browser assistant connection is not configured yet.");
  }

  async renameConversation(conversationId: string, name: string): Promise<ConversationDetail> {
    await this.updatePreference(conversationId, (current) => ({
      ...current,
      customName: name.trim()
    }));
    return this.loadDetail(conversationId);
  }

  async markConversationRead(conversationId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const incomingIds = detail.messages
      .filter((message) => message.direction === "incoming")
      .map((message) => message.id);
    await this.updatePreference(conversationId, (current) => ({
      ...current,
      locallyReadMessageIds: unique([...(current.locallyReadMessageIds ?? []), ...incomingIds]),
      locallyUnreadMessageIds: (current.locallyUnreadMessageIds ?? []).filter(
        (id) => !incomingIds.includes(id)
      )
    }));
    return this.loadDetail(conversationId);
  }

  async markConversationUnread(conversationId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const latestIncoming = [...detail.messages].reverse().find(
      (message) => message.direction === "incoming"
    );
    if (!latestIncoming) return detail;
    await this.updatePreference(conversationId, (current) => ({
      ...current,
      locallyReadMessageIds: (current.locallyReadMessageIds ?? []).filter(
        (id) => id !== latestIncoming.id
      ),
      locallyUnreadMessageIds: unique([
        ...(current.locallyUnreadMessageIds ?? []),
        latestIncoming.id
      ])
    }));
    return this.loadDetail(conversationId);
  }

  async runConversationAction(
    conversationId: string,
    action: ConversationAction
  ): Promise<ConversationDetail> {
    if (action === "check_history") {
      throw new Error("Historical relationship lookup is not available in the browser slice yet.");
    }
    const archivedAt = new Date().toISOString();
    await this.updatePreference(conversationId, (current) => {
      if (action === "archive") return { ...current, archivedAt };
      if (action === "unarchive") return { ...current, archivedAt: "" };
      if (action === "accept") return { ...current, admission: "accepted" };
      if (action === "keep_request") return { ...current, admission: "kept_request" };
      if (action === "junk") return { ...current, moderation: "junk" };
      if (action === "not_junk") return { ...current, moderation: "normal" };
      if (action === "trash") return { ...current, moderation: "trash" };
      return { ...current, moderation: "normal" };
    });
    return this.loadDetail(conversationId);
  }

  private async runRefresh(): Promise<MailboxSyncStatus> {
    const attemptedAt = new Date().toISOString();
    this.status = {
      ...this.status,
      state: "syncing",
      lastAttemptAt: attemptedAt,
      lastError: null
    };
    try {
      if (this.sourceSync) {
        await this.sourceSync.sync(this.mailbox, await this.store.listMessages(this.mailbox),
          new BrowserOutlookGraphClient(() => getOutlookAccessToken(this.mailbox.providerAccountId)));
      } else {
      const synchronizer = new BrowserOutlookSynchronizer(
        this.store,
        new BrowserOutlookGraphClient(
          () => getOutlookAccessToken(this.mailbox.providerAccountId)
        )
      );
      for (const folderKind of ["inbox", "sent_items"] as const) {
        const synced = await synchronizer.syncFolder(this.mailbox, folderKind);
        this.mailbox = synced.mailbox;
      }
      }
      await this.reproject();
      this.replicateEncryptedMailbox();
      const completedAt = new Date().toISOString();
      this.status = {
        ...this.status,
        state: "idle",
        lastSuccessfulAt: completedAt,
        lastError: null
      };
      return { ...this.status };
    } catch (caught) {
      if (caught && typeof caught === "object" && "code" in caught && String(caught.code).includes("resource-exhausted")) this.quotaRetryAt = Date.now() + 6 * 60 * 60_000;
      this.status = {
        ...this.status,
        state: "error",
        lastError: caught instanceof Error ? caught.message : "Mailbox refresh failed"
      };
      throw caught;
    }
  }

  private async updatePreference(
    conversationId: string,
    update: (current: BrowserConversationPreference) => BrowserConversationPreference
  ): Promise<void> {
    if (this.syncPromise) await this.syncPromise.catch(() => undefined);
    if (this.organizationActions) {
      await this.organizationActions.edit(conversationId, update);
      await this.reproject();
      return;
    }
    this.mailbox = await this.store.updateConversationPreference(
      this.mailbox,
      conversationId,
      update
    );
    await this.reproject();
    this.replicateEncryptedMailbox();
  }

  private async reproject(): Promise<void> {
    if (this.sourceSync) this.mailbox = await this.sourceSync.effectiveMailbox(this.mailbox);
    const baseline = await this.store.listMessages(this.mailbox);
    const messages = this.sourceSync ? mergeSourceMemberships(baseline, await this.sourceSync.memberships(this.mailbox, baseline)) : baseline;
    this.projection = await projectBrowserConversations({
      mailbox: this.mailbox,
      messages,
      vaultKey: this.vaultKey
    });
    if (this.organizationActions) {
      const targets = [...this.projection.details.keys()].filter(id => id !== "boxie");
      const preferences = await this.organizationActions.refresh(targets, this.sourceSync ? this.mailbox.conversationPreferences : undefined);
      const projectedMailbox = {...this.mailbox, conversationPreferences: preferences};
      this.projection = await projectBrowserConversations({mailbox: projectedMailbox, messages, vaultKey: this.vaultKey});
    }
  }

  private replicateEncryptedMailbox(): void {
    if (!this.cloudReplicator || this.sourceSync) return;
    if (this.replicaPromise) {
      this.replicaRerunRequested = true;
      return;
    }
    const current = this.status.encryptedReplica;
    this.status = {
      ...this.status,
      encryptedReplica: {
        state: "syncing",
        pendingCount: current?.pendingCount ?? 0,
        lastSuccessfulAt: current?.lastSuccessfulAt ?? null,
        lastError: null
      }
    };
    this.replicaPromise = this.cloudReplicator.drain()
      .then((result) => {
        this.status = {
          ...this.status,
          encryptedReplica: {
            state: "idle",
            pendingCount: result.remaining,
            lastSuccessfulAt: new Date().toISOString(),
            lastError: null
          }
        };
      })
      .catch(async (caught) => {
        reportFailure('sync');
        this.status = {
          ...this.status,
          encryptedReplica: {
            state: "error",
            pendingCount: await this.cloudReplicator!.pendingCount(),
            lastSuccessfulAt: this.status.encryptedReplica?.lastSuccessfulAt ?? null,
            lastError: caught instanceof Error
              ? caught.message.slice(0, 500)
              : "Encrypted cloud replication failed"
          }
        };
      })
      .finally(() => {
        this.replicaPromise = null;
        if (this.replicaRerunRequested) {
          this.replicaRerunRequested = false;
          this.replicateEncryptedMailbox();
        }
      });
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
