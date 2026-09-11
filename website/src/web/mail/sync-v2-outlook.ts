import {VaultConsolidation, mergeImportedMessages} from './vault-consolidation';
import {canonical} from "../../contracts/sync/protocol";
import {isRemovedMessage, type GraphDeltaPage, type GraphMessage, type OutlookFolderKind} from "../../server/providers/outlook/types";
import {deriveOpaqueObjectId} from "../vault-spike/crypto";
import {assertCanonicalMessage, type BrowserCanonicalMailbox, type BrowserCanonicalMessage} from "./canonical-types";
import {buildBrowserInitialDeltaUrl} from "./browser-outlook-graph-client";
import {SyncedIngestion} from "./sync-v2-ingestion";
import {SyncLeaseBusy, type SyncV2Store, type IngestionLease} from "./sync-v2-store";

type Vault = {vaultId: string; epoch: number; vaultKey: Uint8Array; deviceId: string};
export interface FolderCheckpoint {activatedAt?: string; url: string; complete: boolean; reset: boolean; seen: string[]; pages: number; items: number}
const membership = (m: BrowserCanonicalMessage) => `${m.accountScopeId}\0${m.folderKind}\0${m.providerMessageId}`;
/** Frozen v1 records are retained as the baseline. V2 folder memberships override
 * that baseline, including tombstones. Pulls only change this read projection. */
export function mergeSourceMemberships(baseline: BrowserCanonicalMessage[], changes: BrowserCanonicalMessage[]): BrowserCanonicalMessage[] {
  const memberships = new Map(baseline.map(m => [membership(m), m]));
  for (const change of changes) memberships.set(membership(change), change);
  const messages = new Map<string, BrowserCanonicalMessage>();
  for (const item of memberships.values()) {
    const key = `${item.accountScopeId}\0${item.providerMessageId}`;
    const prior = messages.get(key);
    if (!prior || (Boolean(prior.providerRemovedAt) && !item.providerRemovedAt)
      || Boolean(prior.providerRemovedAt) === Boolean(item.providerRemovedAt) &&
        `${item.providerPayload.lastModifiedDateTime ?? ""}:${item.folderKind}` > `${prior.providerPayload.lastModifiedDateTime ?? ""}:${prior.folderKind}`) messages.set(key, item);
  }
  return [...messages.values()];
}
export function normalizeSource(mailbox: BrowserCanonicalMailbox, folder: OutlookFolderKind, item: GraphDeltaPage["value"][number], previous: BrowserCanonicalMessage | undefined, now: string): BrowserCanonicalMessage | null {
  if (isRemovedMessage(item)) {
    if (!previous || previous.providerRemovedAt) return null;
    return {...previous, providerRemovedAt: now, providerRemovedReason: item["@removed"].reason ?? null, updatedAt: now};
  }
  item = {...previous?.providerPayload, ...item};
  const received = Date.parse(item.receivedDateTime ?? "");
  if (!Number.isFinite(received)) throw new Error("Outlook message has no valid received date");
  if (received < Date.parse(mailbox.activatedAt)) return null;
  if (previous) {
    if (Date.parse(previous.providerPayload.lastModifiedDateTime ?? "") > Date.parse(item.lastModifiedDateTime ?? "")) return null;
    if (!previous.providerRemovedAt && canonical(previous.providerPayload) === canonical(item)) return null;
  }
  return {schemaVersion: 2, kind: "boxie-canonical-message", provider: "outlook", accountScopeId: mailbox.accountScopeId,
    providerMessageId: item.id, folderKind: folder, direction: folder === "inbox" ? "incoming" : "outgoing", providerPayload: item,
    observedAt: previous?.observedAt ?? now, updatedAt: now, providerRemovedAt: null, providerRemovedReason: null};
}
export class SyncedOutlook {
  private readonly ingestion: SyncedIngestion;
  private readonly consolidation: VaultConsolidation;
  private readonly cache = new Map<string, {revision: string; value: BrowserCanonicalMessage}>();
  constructor(private readonly store: SyncV2Store, private readonly vault: Vault) {this.ingestion = new SyncedIngestion(store, {...vault, deviceId: crypto.randomUUID()}); this.consolidation = new VaultConsolidation(store, vault);}
  private id(namespace: string, logicalId: string) {return deriveOpaqueObjectId({vaultKey: this.vault.vaultKey, namespace, logicalId});}
  async effectiveMailbox(mailbox: BrowserCanonicalMailbox): Promise<BrowserCanonicalMailbox> {
    const imports = await this.consolidation.load(mailbox);
    return {...mailbox, consolidationBaselineActivatedAt: mailbox.consolidationBaselineActivatedAt ?? mailbox.activatedAt, activatedAt: [mailbox.activatedAt, ...imports.map(i => i.mailbox.activatedAt)].sort((a,b) => Date.parse(a)-Date.parse(b))[0]!,
      conversationPreferences: Object.assign({}, ...imports.slice().reverse().map(i => i.mailbox.conversationPreferences), mailbox.conversationPreferences)};
  }
  async memberships(mailbox: BrowserCanonicalMailbox, baseline: BrowserCanonicalMessage[], renew?: () => Promise<void>): Promise<BrowserCanonicalMessage[]> {
    const values = new Map(baseline.filter(m => m.accountScopeId === mailbox.accountScopeId).map(m => [membership(m), m]));
    const streams = await Promise.all((["inbox", "sent_items"] as const).map(folder => this.id("sync-v2-stream", `${mailbox.providerAccountId}\0${folder}`)));
    let renewedAt = performance.now();
    for (const {objectId, head} of await this.store.listHeads()) {
      if (renew && performance.now() - renewedAt >= 30_000) { await renew(); renewedAt = performance.now(); }
      if (head.kind !== "source" || !streams.includes(head.stream ?? "")) continue;
      let cached = this.cache.get(objectId);
      if (cached?.revision !== head.revision) {
        const raw = await this.ingestion.source(objectId, head.stream!, head);
        const value = assertCanonicalMessage(raw.value);
        if (value.accountScopeId !== mailbox.accountScopeId || !["inbox", "sent_items"].includes(value.folderKind)
          || head.stream !== await this.id("sync-v2-stream", `${mailbox.providerAccountId}\0${value.folderKind}`)
          || objectId !== await this.id("sync-v2-source", `${head.stream}\0${value.providerMessageId}`)) throw new Error("Source membership identity mismatch");
        cached = {revision: raw.revision!, value}; this.cache.set(objectId, cached);
      }
      values.set(membership(cached.value), cached.value);
    }
    const imports = await this.consolidation.load(mailbox);
    return mergeImportedMessages([...values.values()], imports.flatMap(i => i.messages), mailbox.consolidationBaselineActivatedAt ?? mailbox.activatedAt);
  }
  async sync(mailbox: BrowserCanonicalMailbox, baseline: BrowserCanonicalMessage[], graph: {getDeltaPage(url: string): Promise<GraphDeltaPage>; getMessage?(id: string, folder: OutlookFolderKind, metadataOnly?: boolean): Promise<GraphMessage>}): Promise<void> {
    mailbox = await this.effectiveMailbox(mailbox);
    if (!Number.isFinite(Date.parse(mailbox.activatedAt)) || mailbox.provider !== "outlook" || mailbox.informationSpace !== "personal") throw new Error("Invalid personal Outlook boundary");
    for (const folder of ["inbox", "sent_items"] as const) {
      const stream = await this.id("sync-v2-stream", `${mailbox.providerAccountId}\0${folder}`);
      // Read-only probe: an empty completed delta needs no ownership or cloud write.
      // If anything changed, reacquire and reload the durable cursor before applying it.
      const probe = await this.ingestion.checkpoint(stream, stream);
      const checkpoint = probe.value as FolderCheckpoint | null;
      if (checkpoint?.complete && !checkpoint.reset && checkpoint.activatedAt === mailbox.activatedAt) {
        try {
          const page = await graph.getDeltaPage(checkpoint.url);
          if (page.value.length === 0 && page["@odata.deltaLink"] && !page["@odata.nextLink"]) continue;
        } catch (error) {if ((error as {status?: number}).status !== 410) throw error;}
      }
      let lease: IngestionLease;
      try {lease = await this.ingestion.acquire(stream);} catch (error) {if (error instanceof SyncLeaseBusy) continue; throw error;}
      let saved = await this.ingestion.checkpoint(stream, stream);
      let state: FolderCheckpoint = saved.value && (saved.value as FolderCheckpoint).activatedAt === mailbox.activatedAt ? saved.value as FolderCheckpoint : {url: buildBrowserInitialDeltaUrl(folder, mailbox.activatedAt), complete: false, reset: true, seen: [], pages: 0, items: 0};
      if (state.complete) state = {...state, pages: 0, items: 0};
      const records = new Map((await this.memberships(mailbox, baseline, async () => {lease = await this.store.renew(lease);})).filter(m => m.folderKind === folder).map(m => [m.providerMessageId, m]));
      let resetAttempted = false;
      for (;;) {
        if (state.pages >= 200 || state.items >= 5000) throw new Error("Outlook sync exceeded its safety limit");
        lease = await this.store.renew(lease);
        let page: GraphDeltaPage;
        try {page = await graph.getDeltaPage(state.url);} catch (error) {
          if (!resetAttempted && (error as {status?: number}).status === 410) {
            resetAttempted = true; state = {url: buildBrowserInitialDeltaUrl(folder, mailbox.activatedAt), complete: false, reset: true, seen: [], pages: 0, items: 0}; continue;
          }
          throw error;
        }
        const next = page["@odata.nextLink"], delta = page["@odata.deltaLink"];
        if (Boolean(next) === Boolean(delta) || state.items + page.value.length > 5000) throw new Error("Invalid Outlook continuation or page limit");
        const changes = new Map<string, BrowserCanonicalMessage>(); const seen = new Set(state.seen); const now = new Date().toISOString();
        for (let item of page.value) {
          if (!isRemovedMessage(item) && !item.receivedDateTime && !records.get(item.id)?.providerPayload.receivedDateTime) {
            if (!graph.getMessage) throw new Error('An incomplete Outlook delta needs a message lookup');
            try {
              const metadata = await graph.getMessage(item.id, folder, true);
              if (metadata.id !== item.id || !Number.isFinite(Date.parse(metadata.receivedDateTime ?? ''))) throw new Error('Outlook message metadata is incomplete');
              if (Date.parse(metadata.receivedDateTime!) < Date.parse(mailbox.activatedAt)) continue;
              item = await graph.getMessage(item.id, folder);
            } catch (error) {if ((error as {status?: number}).status === 404) item = {id: item.id, '@removed': {reason: 'deleted'}}; else throw error;}
          }

          if (state.reset) {if (isRemovedMessage(item)) seen.delete(item.id); else seen.add(item.id);}
          const value = normalizeSource(mailbox, folder, item, records.get(item.id), now);
          if (value) {records.set(item.id, value); changes.set(item.id, value);}
        }
        if (state.reset && delta) for (const [id, value] of records) {
          if (!seen.has(id) && !value.providerRemovedAt) changes.set(id, {...value, providerRemovedAt: now, providerRemovedReason: "absent_after_reset", providerResetActivatedAt: mailbox.activatedAt, updatedAt: now});
        }
        const checkpoint: FolderCheckpoint = {activatedAt: mailbox.activatedAt, url: next ?? delta!, complete: Boolean(delta), reset: Boolean(next) && state.reset,
          seen: next && state.reset ? [...seen].sort() : [], pages: state.pages + 1, items: state.items + page.value.length};
        const sources = await Promise.all([...changes].map(async ([id, value]) => ({objectId: await this.id("sync-v2-source", `${stream}\0${id}`), value})));
        const result = await this.ingestion.publishPage({lease, checkpointId: stream, expectedCheckpoint: saved.revision, sources, checkpoint});
        lease = result.lease; saved = {revision: result.revision, value: checkpoint}; state = checkpoint;
        if (delta) break;
      }
    }
  }
}
