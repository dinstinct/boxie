import {beforeEach, describe, expect, it, vi} from "vitest";
const persisted = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./sync-read-cache", () => ({readSyncCache: async (key: string) => persisted.get(key) ?? null, writeSyncCache: async (key: string, value: unknown) => {persisted.set(key, structuredClone(value));}}));
const io = vi.hoisted(() => ({batches: [] as any[], queries: [] as any[], documents: new Map<string, any>(), cached: new Map<string, any>(), reads: [] as string[]}));
vi.mock("firebase/firestore", async importOriginal => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {...actual,
    collection: (_: unknown, path: string) => ({path}), doc: (_: unknown, path: string) => ({path}),
    where: (field: string, op: string, value: unknown) => ({field, op, value}),
    query: (ref: unknown, clause: unknown) => ({ref, clause}),
    getDocsFromServer: async (query: unknown) => {io.queries.push(query); const next = io.batches.shift(); if (next instanceof Error) throw next; return {docs: next ?? []};},
    getDocFromCache: async ({path}: {path: string}) => {if (!io.cached.has(path)) throw new Error("miss"); return io.cached.get(path);},
    getDocFromServer: async ({path}: {path: string}) => {io.reads.push(path); const result = io.documents.get(path); if (!result) throw new Error("offline"); io.cached.set(path, result); return result;}
  };
});
import {Timestamp, type Firestore} from "firebase/firestore";
import {SyncV2Store} from "./sync-v2-store";
const head = (id: string, time: Timestamp, revision = "one") => ({id, data: () => ({protocol: 2, epoch: 1, kind: "source", revision, updatedAt: time})});
const snapshot = (fields: Record<string, unknown>, pending = false) => ({exists: () => true, metadata: {hasPendingWrites: pending}, get: (field: string) => fields[field]});
beforeEach(() => {persisted.clear(); io.batches = []; io.queries = []; io.documents.clear(); io.cached.clear(); io.reads = [];});
describe("incremental sync reads", () => {
  it("retains the complete index and queries inclusively at nanosecond precision", async () => {
    const store = new SyncV2Store({app: {options: {projectId: "test"}}} as Firestore, "user", "vault", 1);
    const boundary = new Timestamp(100, 123456789);
    io.batches.push([head("old", new Timestamp(99, 0)), head("a", boundary)], [head("a", boundary), head("b", boundary)], []);
    expect(await store.listHeads()).toHaveLength(2);
    expect((await store.listHeads()).map(x => x.objectId)).toEqual(["old", "a", "b"]);
    expect(io.queries[1].clause).toEqual({field: "updatedAt", op: ">=", value: boundary});
    expect(await store.listHeads()).toHaveLength(3);
  });
  it("does not advance after failed or malformed pulls and retries the same boundary", async () => {
    const store = new SyncV2Store({app: {options: {projectId: "test"}}} as Firestore, "user", "vault", 1);
    const boundary = new Timestamp(10, 0);
    io.batches.push([head("a", boundary)], new Error("offline"), [{id: "bad", data: () => ({epoch: 2})}], [head("b", new Timestamp(11, 0))]);
    await store.listHeads();
    await expect(store.listHeads()).rejects.toThrow("offline");
    await expect(store.listHeads()).rejects.toThrow("checkpoint");
    expect(await store.listHeads()).toHaveLength(2);
    expect(io.queries.slice(1).every(q => q.clause.value.isEqual(boundary))).toBe(true);
  });
  it("restores the complete index after restart and catches equal-time changes without a full query", async () => {
    const db = {app: {options: {projectId: "test"}}} as Firestore;
    io.batches.push([head("old", new Timestamp(9, 0)), head("a", new Timestamp(10, 9))]);
    await new SyncV2Store(db, "user", "vault", 1).listHeads();
    io.batches.push([head("b", new Timestamp(10, 9))]);
    const restored = await new SyncV2Store(db, "user", "vault", 1).listHeads();
    expect(restored.map(x => x.objectId)).toEqual(["old", "a", "b"]);
    expect(io.queries[1].clause.value.isEqual(new Timestamp(10, 9))).toBe(true);
    io.batches.push([]);
    expect(await new SyncV2Store(db, "different-user", "vault", 1).listHeads()).toEqual([]);
    expect(io.queries[2].clause).toBeUndefined();
    persisted.clear(); io.batches.push([]);
    await new SyncV2Store(db, "user", "vault", 1).listHeads();
    expect(io.queries[3].clause).toBeUndefined();
  });
  it("downloads immutable chunks once and retries missing chunks without re-reading the manifest", async () => {
    const store = new SyncV2Store({app: {options: {projectId: "test"}}} as Firestore, "user", "vault", 1);
    const path = "boxie/user/vaults/vault/syncObjects/object/revisions/rev";
    io.documents.set(path, snapshot({epoch: 1, chunkCount: 1, ciphertextSize: 3, envelope: {epoch: 1}}));
    await expect(store.read("object", "rev")).rejects.toThrow("offline");
    io.documents.set(path + "/chunks/0000", snapshot({epoch: 1, index: 0, ciphertext: "abc"}));
    expect((await store.read("object", "rev")).ciphertext).toBe("abc");
    const before = io.reads.length;
    await store.read("object", "rev");
    expect(io.reads).toHaveLength(before);
    expect(io.reads.filter(x => x === path)).toHaveLength(1);
  });
  it("does not trust cached pending writes", async () => {
    const store = new SyncV2Store({app: {options: {projectId: "test"}}} as Firestore, "user", "vault", 1);
    const path = "boxie/user/vaults/vault/syncObjects/object/revisions/rev";
    io.cached.set(path, snapshot({epoch: 1}, true));
    await expect(store.read("object", "rev")).rejects.toThrow("offline");
    expect(io.reads).toEqual([path]);
  });
});
