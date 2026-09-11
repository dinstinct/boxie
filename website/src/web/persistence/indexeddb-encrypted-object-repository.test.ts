import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { EncryptedObject } from "../vault-spike/types";
import {
  deleteIndexedDbEncryptedObjectVault,
  IndexedDbEncryptedObjectRepository
} from "./indexeddb-encrypted-object-repository";

describe("IndexedDbEncryptedObjectRepository", () => {
  it("deletes only the selected vault during recovery", async () => {
    const oldVault = new IndexedDbEncryptedObjectRepository("reset-user", "old-vault");
    const currentVault = new IndexedDbEncryptedObjectRepository("reset-user", "current-vault");
    await oldVault.put(record("old-object"));
    await currentVault.put(record("current-object"));

    await deleteIndexedDbEncryptedObjectVault("reset-user", "old-vault");

    await expect(oldVault.list()).resolves.toEqual([]);
    await expect(currentVault.list()).resolves.toHaveLength(1);
  });
});

function record(objectId: string) {
  return {
    objectId,
    encrypted: {
      schemaVersion: 1,
      epoch: 1,
      algorithm: "AES-256-GCM",
      contentType: "application/vnd.boxie.conversation-snapshot+json",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
      wrappedKeyNonce: "opaque-wrapped-nonce",
      wrappedKey: "opaque-wrapped-key"
    } satisfies EncryptedObject
  };
}
