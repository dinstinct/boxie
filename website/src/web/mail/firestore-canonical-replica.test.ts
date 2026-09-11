import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { EncryptedObject } from "../vault-spike/types";
import {
  CanonicalCloudReplicator,
  MemoryCanonicalReplicationQueue,
  replicaRevision,
  type PendingCanonicalReplication
} from "./canonical-cloud-replication";
import type { EncryptedCanonicalRecord } from "./encrypted-canonical-repository";
import {
  ChunkedCanonicalCloudRepository,
  MAX_CHUNK_CIPHERTEXT_CHARS,
  MAX_INLINE_CIPHERTEXT_CHARS,
  MemoryCanonicalReplicaDocumentStore,
  type CanonicalReplicaChunk
} from "./firestore-canonical-replica";

describe("encrypted canonical Firestore replica", () => {
  it("downloads a frozen baseline once, skips duplicate manifest reads, and reuses it across restart", async () => {
    const documents = new MemoryCanonicalReplicaDocumentStore();
    const input = pending(record("baseline", "encrypted"));
    await new ChunkedCanonicalCloudRepository(documents).put(input);
    const manifests = vi.spyOn(documents, "listManifests"); const get = vi.spyOn(documents, "getManifest");
    const cache = {key: `test/${crypto.randomUUID()}`, epoch: input.encrypted.epoch};
    expect(await new ChunkedCanonicalCloudRepository(documents, cache).list()).toHaveLength(1);
    expect(manifests).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled();
    manifests.mockRejectedValue(new Error("offline"));
    expect(await new ChunkedCanonicalCloudRepository(documents, cache).list()).toHaveLength(1);
    expect(manifests).toHaveBeenCalledTimes(1);
    await expect(new ChunkedCanonicalCloudRepository(documents, {...cache, key: cache.key + "/other-epoch"}).list()).rejects.toThrow("offline");
  });
  it("stores a normal encrypted message inline and reconstructs the envelope", async () => {
    const documents = new MemoryCanonicalReplicaDocumentStore();
    const cloud = new ChunkedCanonicalCloudRepository(documents);
    const input = pending(record("message-inline", "opaque-ciphertext"));

    await cloud.put(input);

    expect(documents.manifests.get(input.objectId)).toMatchObject({
      state: "complete",
      storage: "inline",
      chunkCount: 0,
      ciphertext: "opaque-ciphertext"
    });
    expect(documents.chunks.size).toBe(0);
    await expect(cloud.get(input.objectId)).resolves.toEqual(stripPending(input));
  });

  it("leaves an interrupted chunk upload incomplete and resumes idempotently", async () => {
    const documents = new FailingChunkStore();
    const cloud = new ChunkedCanonicalCloudRepository(documents);
    const ciphertext = "A".repeat(MAX_INLINE_CIPHERTEXT_CHARS + MAX_CHUNK_CIPHERTEXT_CHARS + 9);
    const input = pending(record("message-chunked", ciphertext));

    await expect(cloud.put(input)).rejects.toThrow("synthetic interrupted upload");
    expect(documents.manifests.get(input.objectId)?.state).toBe("uploading");
    await expect(cloud.get(input.objectId)).resolves.toBeNull();

    await cloud.put(input);

    expect(documents.manifests.get(input.objectId)).toMatchObject({
      state: "complete",
      storage: "chunked",
      chunkCount: 3,
      ciphertextSize: ciphertext.length
    });
    await expect(cloud.get(input.objectId)).resolves.toEqual(stripPending(input));
  });

  it("removes stale chunk documents when an object becomes inline", async () => {
    const documents = new MemoryCanonicalReplicaDocumentStore();
    const cloud = new ChunkedCanonicalCloudRepository(documents);
    const first = pending(record(
      "message-rewritten",
      "A".repeat(MAX_INLINE_CIPHERTEXT_CHARS + 1),
      "nonce-one"
    ));
    await cloud.put(first);
    expect(documents.chunks.size).toBe(2);

    const second = pending(record("message-rewritten", "small", "nonce-two"));
    await cloud.put(second);

    expect(documents.chunks.size).toBe(0);
    await expect(cloud.get(second.objectId)).resolves.toEqual(stripPending(second));
  });

  it("continues draining when a newer encrypted revision appears mid-upload", async () => {
    const first = record("message-race", "first", "nonce-one");
    const second = record("message-race", "second", "nonce-two");
    const queue = new MemoryCanonicalReplicationQueue([first]);
    const documents = new MemoryCanonicalReplicaDocumentStore();
    const cloud = new ChunkedCanonicalCloudRepository(documents);
    const replicator = new CanonicalCloudReplicator(queue, {
      ...cloud,
      put: async (pendingRecord) => {
        await cloud.put(pendingRecord);
        if (pendingRecord.replicaRevision === replicaRevision(first)) queue.put(second);
      },
      get: (objectId) => cloud.get(objectId),
      list: () => cloud.list(),
      delete: (objectId) => cloud.delete(objectId)
    });

    await expect(replicator.drain()).resolves.toMatchObject({ uploaded: 2, remaining: 0 });
    await expect(cloud.get(second.objectId)).resolves.toEqual(second);
  });
});

class FailingChunkStore extends MemoryCanonicalReplicaDocumentStore {
  private failed = false;

  override async putChunk(objectId: string, chunk: CanonicalReplicaChunk): Promise<void> {
    if (!this.failed && chunk.index === 1) {
      this.failed = true;
      throw new Error("synthetic interrupted upload");
    }
    await super.putChunk(objectId, chunk);
  }
}

function record(
  objectId: string,
  ciphertext: string,
  nonce = "opaque-nonce"
): EncryptedCanonicalRecord {
  return {
    objectId: opaqueId(objectId),
    accountScopeId: opaqueId("account-scope"),
    kind: "message",
    encrypted: {
      schemaVersion: 1,
      epoch: 2,
      algorithm: "AES-256-GCM",
      contentType: "application/vnd.boxie.canonical-message+json",
      nonce,
      ciphertext,
      wrappedKeyNonce: `wrapped-${nonce}`,
      wrappedKey: "opaque-wrapped-key"
    } satisfies EncryptedObject
  };
}

function opaqueId(seed: string): string {
  const safe = seed.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
  return `obj_${safe.padEnd(43, "x").slice(0, 43)}`;
}

function pending(value: EncryptedCanonicalRecord): PendingCanonicalReplication {
  return { ...value, replicaRevision: replicaRevision(value) };
}

function stripPending(value: PendingCanonicalReplication): EncryptedCanonicalRecord {
  const { replicaRevision: _replicaRevision, ...record } = value;
  return record;
}

// Characterization of v1 protocol hazards, not desired behavior. Replace these
// assertions with convergence guarantees when the versioned protocol is migrated.
describe("v1 multi-writer audit reproductions", () => {
  it("demonstrates that a stale writer can replace a newer envelope", async () => {
    const cloud = new ChunkedCanonicalCloudRepository(new MemoryCanonicalReplicaDocumentStore());
    const old = pending(record("shared-object", "old-state", "old"));
    const newer = pending(record("shared-object", "new-state", "new"));
    await cloud.put(newer);
    await cloud.put(old);
    expect(await cloud.get(old.objectId)).toEqual(stripPending(old));
  });

  it("demonstrates mixed chunks from overlapping writers despite successful uploads", async () => {
    const a = pending(record("shared-large", "A".repeat(MAX_INLINE_CIPHERTEXT_CHARS + 1), "a"));
    const b = pending(record("shared-large", "B".repeat(MAX_INLINE_CIPHERTEXT_CHARS + 1), "b"));
    let interleaved = false;
    class InterleavedStore extends MemoryCanonicalReplicaDocumentStore {
      override async putChunk(id: string, chunk: CanonicalReplicaChunk) {
        await super.putChunk(id, chunk);
        if (!interleaved && chunk.replicaRevision === a.replicaRevision && chunk.index === 0) {
          interleaved = true;
          await cloud.put(b);
        }
      }
    }
    const cloud = new ChunkedCanonicalCloudRepository(new InterleavedStore());
    await cloud.put(a);
    await expect(cloud.get(a.objectId)).rejects.toThrow(/does not match/);
  });

  it("demonstrates that the outbox has no checkpoint dependency barrier", async () => {
    const message = record("new-message", "mail");
    const mailbox: EncryptedCanonicalRecord = {
      ...record("mailbox", "advanced-cursor"), kind: "mailbox",
      encrypted: {...message.encrypted, contentType: "application/vnd.boxie.canonical-mailbox+json"}
    };
    const published: string[] = [];
    const queue = new MemoryCanonicalReplicationQueue([mailbox, message]);
    const replicator = new CanonicalCloudReplicator(queue, {
      put: async value => {
        if (value.kind === "message") throw new Error("offline");
        published.push(value.kind);
      },
      get: async () => null, list: async () => [], delete: async () => {}
    });
    await expect(replicator.drain()).rejects.toThrow("offline");
    expect(published).toEqual(["mailbox"]);
    expect(await queue.pendingCount()).toBe(1);
  });
});
