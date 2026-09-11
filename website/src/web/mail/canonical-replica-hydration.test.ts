import { describe, expect, it, vi } from "vitest";
import type { CanonicalCloudRepository } from "./canonical-cloud-replication";
import { hydrateMissingCanonicalReplica } from "./canonical-replica-hydration";
import type { EncryptedCanonicalRecord } from "./encrypted-canonical-repository";

describe("hydrateMissingCanonicalReplica", () => {
  it("checks the cloud and imports missing records even when local state already exists", async () => {
    const remote = [record("remote-message")];
    const local = { importReplicated: vi.fn().mockResolvedValue(1) };
    const cloud = {
      list: vi.fn().mockResolvedValue(remote)
    } as unknown as CanonicalCloudRepository;

    await expect(hydrateMissingCanonicalReplica({ local, cloud })).resolves.toEqual({
      discovered: 1,
      imported: 1
    });
    expect(local.importReplicated).toHaveBeenCalledWith(remote);
  });
});

function record(objectId: string): EncryptedCanonicalRecord {
  return {
    objectId,
    accountScopeId: "account-scope",
    kind: "message",
    encrypted: {
      schemaVersion: 1,
      epoch: 1,
      algorithm: "AES-256-GCM",
      contentType: "application/vnd.boxie.canonical-message+json",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
      wrappedKeyNonce: "opaque-wrapped-nonce",
      wrappedKey: "opaque-wrapped-key"
    }
  };
}
