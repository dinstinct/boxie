import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { EncryptedObject } from "../vault-spike/types";
import {
  deleteIndexedDbCanonicalVault,
  IndexedDbEncryptedCanonicalRepository
} from "./encrypted-canonical-repository";

describe("IndexedDbEncryptedCanonicalRepository", () => {
  it("commits an account-scoped encrypted batch and filters by opaque kind", async () => {
    const repository = new IndexedDbEncryptedCanonicalRepository(
      "test-user-repository",
      "test-vault-repository"
    );
    const mailbox = record("mailbox-id", "scope-id", "mailbox");
    const message = record("message-id", "scope-id", "message");
    await repository.putMany([mailbox, message]);

    await expect(repository.get("mailbox-id")).resolves.toEqual(mailbox);
    await expect(repository.list("scope-id", "message")).resolves.toEqual([message]);
    await expect(repository.pendingCount()).resolves.toBe(2);
    const pending = await repository.listPending();
    await repository.markReplicated(pending[0]!.objectId, pending[0]!.replicaRevision);
    await expect(repository.pendingCount()).resolves.toBe(1);
    await repository.delete("message-id");
    await expect(repository.list("scope-id", "message")).resolves.toEqual([]);
    await expect(repository.pendingCount()).resolves.toBe(0);
  });

  it("does not acknowledge a newer local rewrite when an older upload finishes", async () => {
    const repository = new IndexedDbEncryptedCanonicalRepository(
      "test-user-revision",
      "test-vault-revision"
    );
    const first = record("message-id", "scope-id", "message");
    await repository.putMany([first]);
    const [oldPending] = await repository.listPending();
    const rewritten = structuredClone(first);
    rewritten.encrypted.nonce = "newer-nonce";
    await repository.putMany([rewritten]);

    await repository.markReplicated(oldPending!.objectId, oldPending!.replicaRevision);

    const [stillPending] = await repository.listPending();
    expect(stillPending?.encrypted.nonce).toBe("newer-nonce");
  });

  it("hydrates missing cloud objects without replacing newer local records", async () => {
    const repository = new IndexedDbEncryptedCanonicalRepository(
      "test-user-hydration",
      "test-vault-hydration"
    );
    const local = record("shared-id", "scope-id", "message");
    local.encrypted.nonce = "local-nonce";
    const remoteShared = structuredClone(local);
    remoteShared.encrypted.nonce = "remote-nonce";
    const remoteMissing = record("missing-id", "scope-id", "message");

    await repository.putMany([local]);
    await expect(repository.importReplicated([remoteShared, remoteMissing])).resolves.toBe(1);

    await expect(repository.get("shared-id")).resolves.toEqual(local);
    await expect(repository.get("missing-id")).resolves.toEqual(remoteMissing);
    expect((await repository.listPending()).map((item) => item.objectId)).toEqual(["shared-id"]);
  });

  it("deletes only the inaccessible vault selected for recovery", async () => {
    const oldVault = new IndexedDbEncryptedCanonicalRepository("reset-user", "old-vault");
    const currentVault = new IndexedDbEncryptedCanonicalRepository("reset-user", "current-vault");
    await oldVault.putMany([record("old-message", "old-scope", "message")]);
    await currentVault.putMany([record("current-message", "current-scope", "message")]);

    await deleteIndexedDbCanonicalVault("reset-user", "old-vault");

    await expect(oldVault.listAll()).resolves.toEqual([]);
    await expect(currentVault.listAll()).resolves.toHaveLength(1);
  });
});

function record(
  objectId: string,
  accountScopeId: string,
  kind: "mailbox" | "message"
) {
  return {
    objectId,
    accountScopeId,
    kind,
    encrypted: {
      schemaVersion: 1,
      epoch: 1,
      algorithm: "AES-256-GCM",
      contentType: kind === "mailbox"
        ? "application/vnd.boxie.canonical-mailbox+json"
        : "application/vnd.boxie.canonical-message+json",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
      wrappedKeyNonce: "opaque-wrapped-nonce",
      wrappedKey: "opaque-wrapped-key"
    } satisfies EncryptedObject
  };
}
