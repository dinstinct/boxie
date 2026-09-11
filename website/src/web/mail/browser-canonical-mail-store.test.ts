import { describe, expect, it } from "vitest";
import type { GraphMessage } from "../../server/providers/outlook/types";
import {
  decryptJsonObject,
  deriveOpaqueObjectId,
  encryptJsonObject
} from "../vault-spike/crypto";
import {
  CANONICAL_MAILBOX_CONTENT_TYPE,
  CANONICAL_MESSAGE_CONTENT_TYPE,
  type LocalVaultState
} from "../vault-spike/types";
import { BrowserCanonicalMailStore } from "./browser-canonical-mail-store";
import { MemoryEncryptedCanonicalRepository } from "./encrypted-canonical-repository";

const localVault = {
  uid: "user-1",
  vaultId: "vault-1",
  epoch: 1
} as LocalVaultState;
const vaultKey = new Uint8Array(32).fill(7);

describe("BrowserCanonicalMailStore", () => {
  it("encrypts mailbox identity, checkpoints, and structured source content", async () => {
    const repository = new MemoryEncryptedCanonicalRepository();
    const store = BrowserCanonicalMailStore.create({ localVault, vaultKey, repository });
    const mailbox = await store.activateOutlookAccount({
      providerAccountId: "microsoft-secret-id",
      emailAddress: "davide@example.com",
      activatedAt: "2026-08-30T10:00:00.000Z"
    });
    const first = await store.persistPage(mailbox, [{
      folderKind: "inbox",
      message: message("message-secret-id"),
      observedAt: "2026-08-30T10:01:00.000Z"
    }], []);

    expect(first).toEqual({ inserted: 1, updated: 0, removed: 0 });
    const records = await repository.list(mailbox.accountScopeId);
    const persistedShape = JSON.stringify(records);
    expect(persistedShape).not.toContain("microsoft-secret-id");
    expect(persistedShape).not.toContain("davide@example.com");
    expect(persistedShape).not.toContain("message-secret-id");
    expect(persistedShape).not.toContain("Private plans");
    expect(persistedShape).not.toContain("Meet at noon");

    const decrypted = await store.listMessages(mailbox);
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]?.providerMessageId).toBe("message-secret-id");
    expect(decrypted[0]?.providerPayload.subject).toBe("Private plans");
    expect(decrypted[0]).not.toHaveProperty("rawMimeBase64Url");
  });

  it("replays messages idempotently and persists encrypted removal state", async () => {
    const repository = new MemoryEncryptedCanonicalRepository();
    const store = BrowserCanonicalMailStore.create({ localVault, vaultKey, repository });
    const mailbox = await store.activateOutlookAccount({
      providerAccountId: "account-1",
      emailAddress: "me@example.com",
      activatedAt: "2026-08-30T10:00:00.000Z"
    });
    const input = {
      folderKind: "inbox" as const,
      message: message("message-1"),
      observedAt: "2026-08-30T10:01:00.000Z"
    };
    await expect(store.persistPage(mailbox, [input], [])).resolves.toEqual({
      inserted: 1,
      updated: 0,
      removed: 0
    });
    await expect(store.persistPage(mailbox, [input], [])).resolves.toEqual({
      inserted: 0,
      updated: 1,
      removed: 0
    });
    await expect(store.persistPage(mailbox, [], [{
      providerMessageId: "message-1",
      reason: "deleted",
      observedAt: "2026-08-30T10:02:00.000Z"
    }])).resolves.toEqual({ inserted: 0, updated: 0, removed: 1 });

    const [stored] = await store.listMessages(mailbox);
    expect(stored).toMatchObject({
      providerRemovedAt: "2026-08-30T10:02:00.000Z",
      providerRemovedReason: "deleted"
    });
  });

  it("preserves the first T0 and advances a durable cursor only on completion", async () => {
    const repository = new MemoryEncryptedCanonicalRepository();
    const store = BrowserCanonicalMailStore.create({ localVault, vaultKey, repository });
    const mailbox = await store.activateOutlookAccount({
      providerAccountId: "account-1",
      emailAddress: "me@example.com",
      activatedAt: "2026-08-30T10:00:00.000Z"
    });
    const secondActivation = await store.activateOutlookAccount({
      providerAccountId: "account-1",
      emailAddress: "alias@example.com",
      activatedAt: "2026-08-30T11:00:00.000Z"
    });
    expect(secondActivation.activatedAt).toBe("2026-08-30T10:00:00.000Z");

    const started = await store.startSync(mailbox, "inbox", "2026-08-30T10:01:00.000Z");
    expect(started.cursors.inbox.deltaLink).toBeNull();
    const completed = await store.completeSync(
      started,
      "inbox",
      "2026-08-30T10:02:00.000Z",
      "https://graph.microsoft.com/v1.0/delta-token"
    );
    const restored = await store.getMailbox("account-1");
    expect(restored).toEqual(completed);
    expect(restored?.cursors.inbox.deltaLink).toContain("delta-token");
  });

  it("removes MIME from existing encrypted browser records once", async () => {
    const repository = new MemoryEncryptedCanonicalRepository();
    const accountScopeId = await deriveOpaqueObjectId({
      vaultKey,
      namespace: "canonical-outlook-account",
      logicalId: "account-1"
    });
    const messageObjectId = await deriveOpaqueObjectId({
      vaultKey,
      namespace: "canonical-outlook-message",
      logicalId: "account-1\0message-1"
    });
    const cursor = {
      deltaLink: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null
    };
    const legacyMailbox = {
      schemaVersion: 1,
      kind: "boxie-canonical-mailbox",
      accountScopeId,
      provider: "outlook",
      providerAccountId: "account-1",
      emailAddress: "me@example.com",
      informationSpace: "personal",
      activatedAt: "2026-08-30T10:00:00.000Z",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      cursors: { inbox: cursor, sent_items: cursor }
    };
    const legacyMessage = {
      schemaVersion: 1,
      kind: "boxie-canonical-message",
      accountScopeId,
      provider: "outlook",
      providerMessageId: "message-1",
      folderKind: "inbox",
      direction: "incoming",
      providerPayload: message("message-1"),
      rawMimeBase64Url: "cHJpdmF0ZS1taW1l",
      rawMimeByteLength: 12,
      observedAt: "2026-08-30T10:01:00.000Z",
      updatedAt: "2026-08-30T10:01:00.000Z",
      providerRemovedAt: null,
      providerRemovedReason: null
    };
    await repository.putMany([
      {
        objectId: accountScopeId,
        accountScopeId,
        kind: "mailbox",
        encrypted: await encryptJsonObject({
          vaultKey,
          vaultId: localVault.vaultId,
          objectId: accountScopeId,
          epoch: localVault.epoch,
          contentType: CANONICAL_MAILBOX_CONTENT_TYPE,
          payload: legacyMailbox
        })
      },
      {
        objectId: messageObjectId,
        accountScopeId,
        kind: "message",
        encrypted: await encryptJsonObject({
          vaultKey,
          vaultId: localVault.vaultId,
          objectId: messageObjectId,
          epoch: localVault.epoch,
          contentType: CANONICAL_MESSAGE_CONTENT_TYPE,
          payload: legacyMessage
        })
      }
    ]);

    const store = BrowserCanonicalMailStore.create({ localVault, vaultKey, repository });
    const mailbox = await store.activateOutlookAccount({
      providerAccountId: "account-1",
      emailAddress: "ignored@example.com",
      activatedAt: "2026-08-30T11:00:00.000Z"
    });
    expect(mailbox.messageStorageRevision).toBe(2);
    const encryptedMessage = await repository.get(messageObjectId);
    const migratedMessage = await decryptJsonObject<Record<string, unknown>>({
      vaultKey,
      vaultId: localVault.vaultId,
      objectId: messageObjectId,
      encrypted: encryptedMessage!.encrypted,
      expectedContentType: CANONICAL_MESSAGE_CONTENT_TYPE
    });
    expect(migratedMessage.schemaVersion).toBe(2);
    expect(migratedMessage).not.toHaveProperty("rawMimeBase64Url");
    expect(migratedMessage).not.toHaveProperty("rawMimeByteLength");
  });
});

function message(id: string): GraphMessage {
  return {
    id,
    subject: "Private plans",
    sender: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    toRecipients: [{ emailAddress: { name: "Davide", address: "davide@example.com" } }],
    receivedDateTime: "2026-08-30T10:01:00.000Z"
  };
}
