import {openDB} from "idb";
import {canonical} from "../../contracts/sync/protocol";
import {decryptJsonObject} from "../vault-spike/crypto";
import {CANONICAL_MAILBOX_CONTENT_TYPE, CANONICAL_MESSAGE_CONTENT_TYPE} from "../vault-spike/types";
import type {CanonicalCloudRepository, CanonicalReplicationQueue, PendingCanonicalReplication} from "./canonical-cloud-replication";
import type {EncryptedCanonicalRecord} from "./encrypted-canonical-repository";

/** Only retire snapshots whose meaningful values already exist in the frozen
 * baseline. Never infer an operation from a differing last-writer-wins snapshot. */
export function representedInBaseline(local: Record<string, unknown>, frozen: Record<string, unknown>): boolean {
  if (local.kind !== frozen.kind || local.accountScopeId !== frozen.accountScopeId) return false;
  const omit = (value: Record<string, unknown>, fields: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
  if (local.kind === "boxie-canonical-mailbox") {
    // Legacy cursors are not imported into v2. Its own T0 scan/checkpoint is authoritative.
    const ignored = ["cursors", "updatedAt", "conversationPreferences"];
    if (canonical(omit(local, ignored)) !== canonical(omit(frozen, ignored))) return false;
    const preferences = (local.conversationPreferences ?? {}) as Record<string, Record<string, unknown>>;
    const baseline = (frozen.conversationPreferences ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(preferences).every(([target, fields]) => Object.entries(fields).every(([field, value]) =>
      canonical(value) === canonical(baseline[target]?.[field] ?? null)));
  }
  if (local.kind === "boxie-canonical-message") {
    return canonical(omit(local, ["observedAt", "updatedAt"])) === canonical(omit(frozen, ["observedAt", "updatedAt"]));
  }
  return false;
}
export async function recoverRepresentedLegacyQueue(options: {
  queue: CanonicalReplicationQueue;
  cloud: Pick<CanonicalCloudRepository, "get">;
  vault: {uid: string; vaultId: string; epoch: number; vaultKey: Uint8Array};
  archive?: (record: PendingCanonicalReplication) => Promise<void>;
}): Promise<{recovered: number; remaining: number}> {
  const {queue, cloud, vault} = options;
  let recovered = 0;
  const decrypt = async (record: EncryptedCanonicalRecord) => {
    if (record.encrypted.epoch !== vault.epoch) throw new Error("Legacy queue epoch mismatch; changes preserved.");
    return decryptJsonObject<Record<string, unknown>>({vaultKey: vault.vaultKey, vaultId: vault.vaultId, objectId: record.objectId,
      encrypted: record.encrypted, expectedContentType: record.kind === "mailbox" ? CANONICAL_MAILBOX_CONTENT_TYPE : CANONICAL_MESSAGE_CONTENT_TYPE});
  };
  const archive = options.archive ?? (async record => {
    const db = await openDB("boxie-legacy-recovery-backup", 1, {upgrade(db) {db.createObjectStore("snapshots");}});
    try {await db.put("snapshots", record, [vault.uid, vault.vaultId, vault.epoch, record.objectId, record.replicaRevision]);}
    finally {db.close();}
  });
  // Read the whole queue once; an unexplained record must not starve later entries.
  for (const pending of await queue.listPending(await queue.pendingCount() || 1)) {
    const frozen = await cloud.get(pending.objectId);
    if (!frozen || frozen.kind !== pending.kind || frozen.accountScopeId !== pending.accountScopeId) continue;
    if (!representedInBaseline(await decrypt(pending), await decrypt(frozen))) continue;
    await archive(pending); // Durable encrypted backup precedes exact-revision acknowledgement.
    await queue.markReplicated(pending.objectId, pending.replicaRevision);
    recovered++;
  }
  return {recovered, remaining: await queue.pendingCount()};
}
