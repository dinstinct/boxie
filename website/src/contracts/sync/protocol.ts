/** Sync v2 domain rules. Transport calls these inside an atomic conditional commit.
 * Payloads are decrypted only on authorized clients. No device wall-clock ordering.
 */
export const SYNC_PROTOCOL = 2 as const;
export type FieldState = { revision: string; value: unknown };
export type Operation = {
  id: string;
  target: string;
  changes: Record<string, { expected: string | null; value: unknown }>;
};
export type OperationResult = { status: "applied" | "conflict"; fields: string[] };
export type Organization = {
  target: string;
  fields: Record<string, FieldState>;
  receipts: Record<string, { operation: Operation; result: OperationResult }>;
};
export class SyncConflict extends Error {}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
function id(value: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value) || forbiddenKeys.has(value)) throw new Error("Invalid sync identity");
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("Sync values must be JSON");
}

/** Receipts make retries idempotent. Same-field conflict is explicit; independent
 * fields merge. No receipt pruning until a separate compaction contract exists. */
export function applyOperation(state: Organization, operation: Operation): { state: Organization; result: OperationResult } {
  id(operation.id); id(operation.target);
  if (state.target !== operation.target) throw new SyncConflict("Wrong operation target");
  const keys = Object.keys(operation.changes).sort();
  if (!keys.length || keys.length > 100) throw new Error("Invalid operation size");
  keys.forEach(id);
  canonical(operation);
  const existing = own(state.receipts, operation.id) ? state.receipts[operation.id] : undefined;
  if (existing) {
    if (canonical(existing.operation) !== canonical(operation)) throw new SyncConflict("Operation ID reused with different content");
    return { state, result: existing.result };
  }
  const conflicts = keys.filter(key => (own(state.fields, key) ? state.fields[key]?.revision : null) !== operation.changes[key]!.expected);
  const result: OperationResult = { status: conflicts.length ? "conflict" : "applied", fields: conflicts };
  const fields = { ...state.fields };
  if (!conflicts.length) for (const key of keys) fields[key] = {revision: operation.id, value: structuredClone(operation.changes[key]!.value)};
  return {
    state: {target: state.target, fields, receipts: {...state.receipts, [operation.id]: {operation: structuredClone(operation), result}}},
    result
  };
}

export type Lease = { owner: string; fence: number; expiresAt: number };
/** now must be an authoritative server timestamp at the commit boundary. */
export function acquireLease(current: Lease | null, owner: string, now: number, ttl: number): Lease {
  id(owner);
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0 || ttl > 120_000) throw new Error("Invalid lease duration");
  if (current && current.expiresAt > now && current.owner !== owner) throw new SyncConflict("Stream already owned");
  const fence = current && current.expiresAt > now ? current.fence : (current?.fence ?? 0) + 1;
  if (!Number.isSafeInteger(fence) || fence <= 0) throw new Error("Invalid fence");
  return {owner, fence, expiresAt: now + ttl};
}
export function assertLease(current: Lease | null, expected: Pick<Lease, "owner" | "fence">, now: number) {
  if (!current || !Number.isFinite(now) || current.owner !== expected.owner || current.fence !== expected.fence || current.expiresAt <= now) {
    throw new SyncConflict("Ingestion ownership expired or changed");
  }
}

export type Revision = { id: string; chunks: string[] };
export type Head = { revision: string; sequence: number };
export type Checkpoint = { cursor: string; sequence: number; fence: number };
export interface StreamState {
  lease: Lease | null;
  revisions: Record<string, Revision>;
  heads: Record<string, Head>;
  checkpoint: Checkpoint | null;
}
export function stageRevision(state: StreamState, revision: Revision): StreamState {
  id(revision.id);
  if (!revision.chunks.length || revision.chunks.length > 8 || revision.chunks.some(c => !c.length || c.length > 350_000)) throw new Error("Invalid encrypted revision");
  const existing = own(state.revisions, revision.id) ? state.revisions[revision.id] : undefined;
  if (existing && canonical(existing) !== canonical(revision)) throw new SyncConflict("Immutable revision collision");
  if (existing) return state;
  return {...state, revisions: {...state.revisions, [revision.id]: structuredClone(revision)}};
}
/** Whole-round reference model: a production adapter may split message commits,
 * but must durably track every dependency before this checkpoint is advanced. */
export function publishRound(state: StreamState, input: {
  lease: Pick<Lease, "owner" | "fence">;
  expectedCheckpoint: number | null;
  cursor: string;
  messages: {objectId: string; revision: string; expectedHead: string | null}[];
}, now: number): StreamState {
  assertLease(state.lease, input.lease, now);
  if ((state.checkpoint?.sequence ?? null) !== input.expectedCheckpoint) throw new SyncConflict("Checkpoint changed");
  if (!input.cursor || input.messages.length > 5000) throw new Error("Invalid round");
  const seen = new Set<string>();
  for (const message of input.messages) {
    id(message.objectId); id(message.revision);
    if (seen.has(message.objectId)) throw new Error("Duplicate message in publication");
    seen.add(message.objectId);
    if (!own(state.revisions, message.revision)) throw new SyncConflict("Message revision is not durable");
    if ((own(state.heads, message.objectId) ? state.heads[message.objectId]?.revision : null) !== message.expectedHead) throw new SyncConflict("Message head changed");
  }
  const sequence = (state.checkpoint?.sequence ?? 0) + 1;
  const heads = {...state.heads};
  for (const message of input.messages) heads[message.objectId] = {revision: message.revision, sequence};
  return {...state, heads, checkpoint: {cursor: input.cursor, sequence, fence: input.lease.fence}};
}

/** A pull changes the acknowledged base, never creates an outgoing mutation. */
export function hydrateBase<T>(current: {revision: string; value: T} | null, remote: {revision: string; value: T}) {
  return current?.revision === remote.revision ? current : structuredClone(remote);
}
