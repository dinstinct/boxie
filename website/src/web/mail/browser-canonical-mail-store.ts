import type {
  GraphMessage,
  OutlookFolderKind
} from "../../server/providers/outlook/types";
import {
  decryptJsonObject,
  deriveOpaqueObjectId,
  encryptJsonObject
} from "../vault-spike/crypto";
import type { LocalVaultState } from "../vault-spike/types";
import {
  CANONICAL_MAILBOX_CONTENT_TYPE,
  CANONICAL_MESSAGE_CONTENT_TYPE
} from "../vault-spike/types";
import {
  IndexedDbEncryptedCanonicalRepository,
  type EncryptedCanonicalRecord,
  type EncryptedCanonicalRepository
} from "./encrypted-canonical-repository";
import {
  assertCanonicalMailbox,
  assertCanonicalMessage,
  needsCanonicalMessageStorageMigration,
  type BrowserCanonicalMailbox,
  type BrowserCanonicalMessage,
  type BrowserConversationPreference
} from "./canonical-types";

export interface BrowserCanonicalMessageInput {
  folderKind: OutlookFolderKind;
  message: GraphMessage;
  observedAt: string;
}

export interface BrowserCanonicalRemovalInput {
  providerMessageId: string;
  reason: string | null;
  observedAt: string;
}

export interface BrowserPersistedPageCounts {
  inserted: number;
  updated: number;
  removed: number;
}

export class BrowserCanonicalMailStore {
  private constructor(
    private readonly localVault: LocalVaultState,
    private readonly vaultKey: Uint8Array,
    private readonly repository: EncryptedCanonicalRepository
  ) {}

  static create(options: {
    localVault: LocalVaultState;
    vaultKey: Uint8Array;
    repository?: EncryptedCanonicalRepository;
  }): BrowserCanonicalMailStore {
    return new BrowserCanonicalMailStore(
      options.localVault,
      options.vaultKey,
      options.repository ?? new IndexedDbEncryptedCanonicalRepository(
        options.localVault.uid,
        options.localVault.vaultId
      )
    );
  }

  async activateOutlookAccount(input: {
    providerAccountId: string;
    emailAddress: string;
    activatedAt: string;
  }): Promise<BrowserCanonicalMailbox> {
    const existing = await this.getMailbox(input.providerAccountId);
    if (existing) {
      return existing;
    }
    assertTimestamp(input.activatedAt, "Boxie activation time");
    if (!input.providerAccountId.trim() || !input.emailAddress.trim()) {
      throw new Error("The confirmed Outlook identity is incomplete.");
    }
    const accountScopeId = await this.accountScopeId(input.providerAccountId);
    const now = new Date().toISOString();
    const cursor = () => ({
      deltaLink: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null
    });
    const mailbox: BrowserCanonicalMailbox = {
      schemaVersion: 1,
      kind: "boxie-canonical-mailbox",
      messageStorageRevision: 2,
      accountScopeId,
      provider: "outlook",
      providerAccountId: input.providerAccountId,
      emailAddress: input.emailAddress,
      informationSpace: "personal",
      activatedAt: input.activatedAt,
      createdAt: now,
      updatedAt: now,
      cursors: { inbox: cursor(), sent_items: cursor() },
      conversationPreferences: {}
    };
    await this.persistMailbox(mailbox);
    return mailbox;
  }

  async getMailbox(providerAccountId: string): Promise<BrowserCanonicalMailbox | null> {
    const objectId = await this.accountScopeId(providerAccountId);
    const record = await this.repository.get(objectId);
    if (!record) return null;
    if (record.kind !== "mailbox" || record.accountScopeId !== objectId) {
      throw new Error("The encrypted account index points to an invalid mailbox object.");
    }
    const payload = await decryptJsonObject<unknown>({
      vaultKey: this.vaultKey,
      vaultId: this.localVault.vaultId,
      objectId,
      encrypted: record.encrypted,
      expectedContentType: CANONICAL_MAILBOX_CONTENT_TYPE
    });
    const requiresMessageMigration = !payload || typeof payload !== "object" ||
      (payload as { messageStorageRevision?: unknown }).messageStorageRevision !== 2;
    const mailbox = assertCanonicalMailbox(payload);
    if (requiresMessageMigration) {
      await this.migrateLegacyMessageRecords(mailbox);
      await this.persistMailbox(mailbox);
    }
    return mailbox;
  }

  async listMailboxes(): Promise<BrowserCanonicalMailbox[]> {
    const records = await this.repository.listAll("mailbox");
    const mailboxes: BrowserCanonicalMailbox[] = [];
    for (const record of records) {
      const payload = await decryptJsonObject<unknown>({
        vaultKey: this.vaultKey,
        vaultId: this.localVault.vaultId,
        objectId: record.objectId,
        encrypted: record.encrypted,
        expectedContentType: CANONICAL_MAILBOX_CONTENT_TYPE
      });
      const requiresMessageMigration = !payload || typeof payload !== "object" ||
        (payload as { messageStorageRevision?: unknown }).messageStorageRevision !== 2;
      const mailbox = assertCanonicalMailbox(payload);
      if (record.accountScopeId !== mailbox.accountScopeId) {
        throw new Error("The encrypted mailbox index does not match its authenticated payload.");
      }
      if (requiresMessageMigration) {
        await this.migrateLegacyMessageRecords(mailbox);
        await this.persistMailbox(mailbox);
      }
      mailboxes.push(mailbox);
    }
    return mailboxes.sort((left, right) => left.activatedAt.localeCompare(right.activatedAt));
  }

  async updateConversationPreference(
    mailbox: BrowserCanonicalMailbox,
    conversationId: string,
    update: (current: BrowserConversationPreference) => BrowserConversationPreference
  ): Promise<BrowserCanonicalMailbox> {
    const next = structuredClone(mailbox);
    next.conversationPreferences[conversationId] = update(
      next.conversationPreferences[conversationId] ?? {}
    );
    next.updatedAt = new Date().toISOString();
    await this.persistMailbox(next);
    return next;
  }

  async startSync(
    mailbox: BrowserCanonicalMailbox,
    folderKind: OutlookFolderKind,
    startedAt: string
  ): Promise<BrowserCanonicalMailbox> {
    const next = structuredClone(mailbox);
    next.cursors[folderKind].lastStartedAt = startedAt;
    next.cursors[folderKind].lastError = null;
    next.updatedAt = startedAt;
    await this.persistMailbox(next);
    return next;
  }

  async completeSync(
    mailbox: BrowserCanonicalMailbox,
    folderKind: OutlookFolderKind,
    completedAt: string,
    deltaLink: string
  ): Promise<BrowserCanonicalMailbox> {
    const next = structuredClone(mailbox);
    next.cursors[folderKind].deltaLink = deltaLink;
    next.cursors[folderKind].lastCompletedAt = completedAt;
    next.cursors[folderKind].lastError = null;
    next.updatedAt = completedAt;
    await this.persistMailbox(next);
    return next;
  }

  async failSync(
    mailbox: BrowserCanonicalMailbox,
    folderKind: OutlookFolderKind,
    failedAt: string,
    error: string
  ): Promise<BrowserCanonicalMailbox> {
    const next = structuredClone(mailbox);
    next.cursors[folderKind].lastError = error.slice(0, 500);
    next.updatedAt = failedAt;
    await this.persistMailbox(next);
    return next;
  }

  async persistPage(
    mailbox: BrowserCanonicalMailbox,
    messages: BrowserCanonicalMessageInput[],
    removals: BrowserCanonicalRemovalInput[]
  ): Promise<BrowserPersistedPageCounts> {
    const records: EncryptedCanonicalRecord[] = [];
    const counts: BrowserPersistedPageCounts = {
      inserted: 0,
      updated: 0,
      removed: 0
    };

    for (const input of messages) {
      const objectId = await this.messageObjectId(mailbox.providerAccountId, input.message.id);
      const existing = await this.repository.get(objectId);
      const payload: BrowserCanonicalMessage = {
        schemaVersion: 2,
        kind: "boxie-canonical-message",
        accountScopeId: mailbox.accountScopeId,
        provider: "outlook",
        providerMessageId: input.message.id,
        folderKind: input.folderKind,
        direction: input.folderKind === "sent_items" ? "outgoing" : "incoming",
        providerPayload: input.message,
        observedAt: input.observedAt,
        updatedAt: input.observedAt,
        providerRemovedAt: null,
        providerRemovedReason: null
      };
      records.push(await this.encryptMessageRecord(mailbox.accountScopeId, objectId, payload));
      counts[existing ? "updated" : "inserted"] += 1;
    }

    for (const removal of removals) {
      const objectId = await this.messageObjectId(
        mailbox.providerAccountId,
        removal.providerMessageId
      );
      const existing = await this.repository.get(objectId);
      if (!existing) continue;
      const payload = assertCanonicalMessage(await decryptJsonObject<unknown>({
        vaultKey: this.vaultKey,
        vaultId: this.localVault.vaultId,
        objectId,
        encrypted: existing.encrypted,
        expectedContentType: CANONICAL_MESSAGE_CONTENT_TYPE
      }));
      payload.providerRemovedAt = removal.observedAt;
      payload.providerRemovedReason = removal.reason;
      payload.updatedAt = removal.observedAt;
      records.push(await this.encryptMessageRecord(mailbox.accountScopeId, objectId, payload));
      counts.removed += 1;
    }

    await this.repository.putMany(records);
    return counts;
  }

  async listMessages(mailbox: BrowserCanonicalMailbox): Promise<BrowserCanonicalMessage[]> {
    const records = await this.repository.list(mailbox.accountScopeId, "message");
    return Promise.all(records.map(async (record) => assertCanonicalMessage(
      await decryptJsonObject<unknown>({
        vaultKey: this.vaultKey,
        vaultId: this.localVault.vaultId,
        objectId: record.objectId,
        encrypted: record.encrypted,
        expectedContentType: CANONICAL_MESSAGE_CONTENT_TYPE
      })
    )));
  }

  private async persistMailbox(mailbox: BrowserCanonicalMailbox): Promise<void> {
    const encrypted = await encryptJsonObject({
      vaultKey: this.vaultKey,
      vaultId: this.localVault.vaultId,
      objectId: mailbox.accountScopeId,
      epoch: this.localVault.epoch,
      contentType: CANONICAL_MAILBOX_CONTENT_TYPE,
      payload: mailbox
    });
    await this.repository.putMany([{
      objectId: mailbox.accountScopeId,
      accountScopeId: mailbox.accountScopeId,
      kind: "mailbox",
      encrypted
    }]);
  }

  private async encryptMessageRecord(
    accountScopeId: string,
    objectId: string,
    payload: BrowserCanonicalMessage
  ): Promise<EncryptedCanonicalRecord> {
    return {
      objectId,
      accountScopeId,
      kind: "message",
      encrypted: await encryptJsonObject({
        vaultKey: this.vaultKey,
        vaultId: this.localVault.vaultId,
        objectId,
        epoch: this.localVault.epoch,
        contentType: CANONICAL_MESSAGE_CONTENT_TYPE,
        payload
      })
    };
  }

  private async migrateLegacyMessageRecords(
    mailbox: BrowserCanonicalMailbox
  ): Promise<void> {
    const records = await this.repository.list(mailbox.accountScopeId, "message");
    const upgraded: EncryptedCanonicalRecord[] = [];
    for (const record of records) {
      const decrypted = await decryptJsonObject<unknown>({
        vaultKey: this.vaultKey,
        vaultId: this.localVault.vaultId,
        objectId: record.objectId,
        encrypted: record.encrypted,
        expectedContentType: CANONICAL_MESSAGE_CONTENT_TYPE
      });
      if (!needsCanonicalMessageStorageMigration(decrypted)) continue;
      upgraded.push(await this.encryptMessageRecord(
        mailbox.accountScopeId,
        record.objectId,
        assertCanonicalMessage(decrypted)
      ));
    }
    await this.repository.putMany(upgraded);
  }

  private accountScopeId(providerAccountId: string): Promise<string> {
    return deriveOpaqueObjectId({
      vaultKey: this.vaultKey,
      namespace: "canonical-outlook-account",
      logicalId: providerAccountId
    });
  }

  private messageObjectId(providerAccountId: string, providerMessageId: string): Promise<string> {
    return deriveOpaqueObjectId({
      vaultKey: this.vaultKey,
      namespace: "canonical-outlook-message",
      logicalId: `${providerAccountId}\0${providerMessageId}`
    });
  }
}

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${label} is invalid.`);
  }
}
