import {describe, expect, it} from "vitest";
import {SyncedIngestion} from "./sync-v2-ingestion";
import {SyncWriteConflict, type IngestionLease, type SyncHead} from "./sync-v2-store";
import type {EncryptedObject} from "../vault-spike/types";

function fixture() {
  const heads = new Map<string, SyncHead>();
  const revisions = new Map<string, EncryptedObject>();
  let fence = 1, fail: string | null = null, writes = 0;
  const lease: IngestionLease = {stream: "inbox", owner: "mac", fence, expiresAt: 90_000};
  const transport = {
    async acquire() {return {...lease, fence};},
    async renew(value: IngestionLease) {if (value.fence !== fence) throw new SyncWriteConflict("Lost lease"); return value;},
    async head(id: string) {return heads.get(id) ?? null;},
    async read(id: string, revision: string) {return revisions.get(`${id}:${revision}`)!;},
    async stage(id: string, revision: string, encrypted: EncryptedObject) {
      if (id === fail) throw new Error("Upload interrupted");
      revisions.set(`${id}:${revision}`, encrypted);
    },
    async publish(id: string, next: Omit<SyncHead, "epoch" | "protocol" | "sequence">) {
      if (next.fence !== fence || (heads.get(id)?.revision ?? null) !== next.baseRevision) throw new SyncWriteConflict("Changed");
      heads.set(id, {...next, epoch: 1, protocol: 2, sequence: (heads.get(id)?.sequence ?? 0) + 1}); writes++;
    }
  };
  const repo = new SyncedIngestion(transport, {vaultId: "vault", epoch: 1, deviceId: "mac", vaultKey: new Uint8Array(32).fill(7)});
  return {repo, transport, heads, lease, setFailure(id: string | null) {fail = id;}, takeover() {fence++;}, writes: () => writes};
}
const page = {checkpointId: "inbox_cursor", expectedCheckpoint: null,
  sources: [{objectId: "inbox_m1", value: {body: "synthetic one"}}, {objectId: "inbox_m2", value: {body: "synthetic two"}}],
  checkpoint: {nextLink: "synthetic-next", complete: false}};

describe("encrypted ingestion page recovery", () => {
  it("keeps the old cursor on partial upload and replay skips already durable sources", async () => {
    const f = fixture(); f.setFailure("inbox_m2");
    await expect(f.repo.publishPage({...page, lease: f.lease})).rejects.toThrow("Upload interrupted");
    const first = f.heads.get("inbox_m1")!.revision;
    expect(f.heads.has("inbox_cursor")).toBe(false);
    f.setFailure(null);
    await f.repo.publishPage({...page, lease: f.lease});
    expect(f.heads.get("inbox_m1")!.revision).toBe(first);
    expect(f.writes()).toBe(3);
    expect((await f.repo.checkpoint("inbox_cursor", "inbox")).value).toEqual(page.checkpoint);
  });
  it("fails a superseded device before advancing its checkpoint", async () => {
    const f = fixture();
    const publish = f.transport.publish;
    f.transport.publish = async (id, head) => {await publish(id, head); if (id === "inbox_m1") f.takeover();};
    await expect(f.repo.publishPage({...page, lease: f.lease})).rejects.toThrow("Changed");
    expect(f.heads.has("inbox_cursor")).toBe(false);
  });
  it("rejects a stale checkpoint before publishing source changes", async () => {
    const f = fixture(); await f.repo.publishPage({...page, lease: f.lease});
    const writes = f.writes();
    await expect(f.repo.publishPage({...page, lease: f.lease})).rejects.toThrow("Checkpoint changed");
    expect(f.writes()).toBe(writes);
  });
  it("rejects duplicate source slots and cross-folder source reuse", async () => {
    const f = fixture();
    await expect(f.repo.publishPage({...page, sources: [page.sources[0]!, page.sources[0]!], lease: f.lease})).rejects.toThrow("Duplicate");
    await f.repo.publishPage({...page, lease: f.lease});
    await expect(f.repo.publishPage({...page, checkpointId: "sent_cursor", lease: {...f.lease, stream: "sent"}})).rejects.toThrow("identity mismatch");
  });
});
