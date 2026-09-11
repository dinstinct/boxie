import {canonical, applyOperation, type Operation, type Organization, type OperationResult} from "../../contracts/sync/protocol";
import {decryptJsonObject, encryptJsonObject} from "../vault-spike/crypto";
import type {EncryptedObject} from "../vault-spike/types";
import {SyncWriteConflict, type SyncHead} from "./sync-v2-store";

export interface OrganizationTransport {
  head(id: string): Promise<SyncHead | null>;
  listHeads?(): Promise<Array<{objectId: string; head: SyncHead}>>;
  read(id: string, revision: string): Promise<EncryptedObject>;
  stage(id: string, revision: string, envelope: EncryptedObject): Promise<void>;
  publish(id: string, head: Omit<SyncHead, "protocol" | "epoch" | "sequence">): Promise<void>;
}
const contentType = "application/vnd.boxie.sync-v2+json";
/** Authenticated revision identity is deliberately independent of a mutable head. */
export function revisionAAD(objectId: string, revision: string): string {
  for (const id of [objectId, revision]) if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid revision identity");
  return `${objectId}:${revision}`;
}
export class SyncedOrganization {
  constructor(private readonly transport: OrganizationTransport, private readonly vault: {vaultId: string; epoch: number; vaultKey: Uint8Array; deviceId: string}) {}
  async load(objectId: string, supplied?: SyncHead | null): Promise<{head: SyncHead | null; state: Organization}> {
    const head = supplied === undefined ? await this.transport.head(objectId) : supplied;
    if (!head) return {head: null, state: {target: objectId, fields: {}, receipts: {}}};
    if (head.protocol !== 2 || head.epoch !== this.vault.epoch || head.kind !== "organization") throw new Error("Invalid organization head");
    const encrypted = await this.transport.read(objectId, head.revision);
    if (encrypted.epoch !== this.vault.epoch) throw new Error("Old vault epoch");
    const value = await decryptJsonObject<{protocol: number; kind: string; state: Organization}>({
      vaultKey: this.vault.vaultKey, vaultId: this.vault.vaultId,
      objectId: revisionAAD(objectId, head.revision), encrypted, expectedContentType: contentType
    });
    if (value.protocol !== 2 || value.kind !== "organization" || value.state.target !== objectId) throw new Error("Organization identity mismatch");
    return {head, state: value.state};
  }
  async loadMany(targets: string[]) {
    if (!this.transport.listHeads) return Object.fromEntries(await Promise.all(targets.map(async id => [id, await this.load(id)])));
    const heads = new Map((await this.transport.listHeads()).map(item => [item.objectId, item.head]));
    const result: Record<string, Awaited<ReturnType<SyncedOrganization["load"]>>> = {};
    for (const target of targets) result[target] = await this.load(target, heads.get(target) ?? null);
    return result;
  }
  /** Seed only a missing head from a frozen legacy snapshot (or an empty new
   * conversation). An existing head always wins; migration verifies its contents
   * separately and never overwrites already-applied user operations. */
  async initialize(objectId: string, values: Record<string, unknown>, origin: string): Promise<{head: SyncHead | null; state: Organization}> {
    revisionAAD(objectId, "seed");
    const existing = await this.load(objectId);
    if (existing.head) return existing;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({objectId, values, origin})));
    const seed = "seed_" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const empty: Organization = {target: objectId, fields: {}, receipts: {}};
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {expected: null, value}]));
    const state = Object.keys(changes).length ? applyOperation(empty, {id: seed, target: objectId, changes}).state : empty;
    const revision = crypto.randomUUID();
    const encrypted = await encryptJsonObject({...this.vault, objectId: revisionAAD(objectId, revision), contentType,
      payload: {protocol: 2, kind: "organization", origin, state}});
    await this.transport.stage(objectId, revision, encrypted);
    try {
      await this.transport.publish(objectId, {kind: "organization", revision, baseRevision: null,
        stream: null, fence: null, owner: this.vault.deviceId});
    } catch (error) {
      if (!(error instanceof SyncWriteConflict)) throw error;
    }
    const result = await this.load(objectId);
    if (!result.head) throw new Error("Organization initialization was not published");
    return result;
  }
  /** The caller retains the operation in its encrypted durable outbox until this
   * resolves. A dropped acknowledgement is safe to retry with the same ID. */
  async apply(operation: Operation): Promise<OperationResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const {head, state} = await this.load(operation.target);
      const next = applyOperation(state, operation);
      if (next.state === state) return next.result;
      const revision = crypto.randomUUID();
      const encrypted = await encryptJsonObject({vaultKey: this.vault.vaultKey, vaultId: this.vault.vaultId,
        objectId: revisionAAD(operation.target, revision), epoch: this.vault.epoch, contentType,
        payload: {protocol: 2, kind: "organization", state: next.state}});
      await this.transport.stage(operation.target, revision, encrypted);
      try {
        await this.transport.publish(operation.target, {kind: "organization", revision,
          baseRevision: head?.revision ?? null, stream: null, fence: null, owner: this.vault.deviceId});
        return next.result;
      } catch (error) {
        if (!(error instanceof SyncWriteConflict) || attempt === 2) throw error;
        // Re-read and reapply the operation, never resend a stale snapshot.
      }
    }
    throw new SyncWriteConflict("Organization remained busy");
  }
}
