import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SNAPSHOT_SCHEMA_VERSION,
  measureConversationSnapshot,
  type ConversationSnapshot
} from "../../contracts/conversations";
import { deriveOpaqueObjectId, randomBytes } from "../vault-spike/crypto";
import type { LocalVaultState } from "../vault-spike/types";
import { CONVERSATION_SNAPSHOT_CONTENT_TYPE } from "../vault-spike/types";
import { MemoryEncryptedObjectRepository } from "./encrypted-object-repository";
import {
  decryptConversationSnapshot,
  encryptConversationSnapshot
} from "./conversation-snapshot-replication";

function snapshot(): ConversationSnapshot {
  return {
    schemaVersion: CONVERSATION_SNAPSHOT_SCHEMA_VERSION,
    kind: "boxie-conversation-snapshot",
    exportedAt: "2026-08-30T12:00:00.000Z",
    readOnly: true,
    coverage: {
      activatedAt: "2026-08-29T09:00:00.000Z",
      messageCount: 1,
      note: "Post-T0 mail only."
    },
    conversations: [{
      id: "conversation-alice",
      kind: "person",
      section: "chats",
      name: "Alice Example",
      address: "alice@example.com",
      initials: "AE",
      avatarSeed: "alice",
      preview: "Private contract detail",
      lastMessageAt: "2026-08-30T11:00:00.000Z",
      messageCount: 1,
      unreadCount: 1,
      topicCount: 1,
      admission: "accepted",
      admissionSource: "user",
      admissionReason: "Accepted by the user.",
      relationshipCheckedAt: null,
      canCheckHistory: false,
      moderation: "normal",
      topics: [{
        id: "topic-atlas",
        title: "Project Atlas",
        messageCount: 1,
        lastMessageAt: "2026-08-30T11:00:00.000Z"
      }],
      messages: [{
        id: "message-one",
        direction: "incoming",
        authorName: "Alice Example",
        authorAddress: "alice@example.com",
        subject: "Project Atlas",
        cleanedText: "Please review section four.",
        originalText: "Please review section four.\n\nBest,\nAlice",
        occurredAt: "2026-08-30T11:00:00.000Z",
        isRead: false,
        webLink: null,
        topicId: "topic-atlas",
        recipients: [{
          kind: "from",
          name: "Alice Example",
          address: "alice@example.com"
        }]
      }]
    }]
  };
}

function localVault(): LocalVaultState {
  return {
    schemaVersion: 1,
    uid: "firebase-user",
    vaultId: "vault-portable-test",
    epoch: 2,
    deviceId: "device-test",
    deviceName: "Test device",
    devicePrivateKey: {} as CryptoKey,
    devicePublicKeyJwk: {},
    deviceWrappingKey: {} as CryptoKey,
    wrappedVaultKeyNonce: "unused",
    wrappedVaultKey: "unused",
    createdAt: 0
  };
}

describe("conversation snapshot replication", () => {
  it("encrypts the projection, stores only ciphertext, and decrypts it back", async () => {
    const payload = snapshot();
    const vaultKey = randomBytes(32);
    const encrypted = await encryptConversationSnapshot({
      prepared: { snapshot: payload, counts: measureConversationSnapshot(payload) },
      localVault: localVault(),
      vaultKey
    });

    expect(encrypted.encrypted.contentType).toBe(CONVERSATION_SNAPSHOT_CONTENT_TYPE);
    expect(JSON.stringify(encrypted.encrypted)).not.toContain("Alice Example");
    expect(JSON.stringify(encrypted.encrypted)).not.toContain("Project Atlas");

    const repository = new MemoryEncryptedObjectRepository();
    await repository.put({
      objectId: encrypted.objectId,
      encrypted: encrypted.encrypted
    });
    const stored = await repository.get(encrypted.objectId);
    expect(stored).not.toBeNull();
    await expect(decryptConversationSnapshot({
      encrypted: stored!.encrypted,
      objectId: stored!.objectId,
      localVault: localVault(),
      vaultKey
    })).resolves.toEqual(payload);
  });

  it("derives a stable opaque ID without exposing the logical identifier", async () => {
    const vaultKey = randomBytes(32);
    const options = {
      vaultKey,
      namespace: "conversation-snapshot",
      logicalId: "personal:v1"
    };
    const first = await deriveOpaqueObjectId(options);
    const second = await deriveOpaqueObjectId(options);
    const otherVault = await deriveOpaqueObjectId({ ...options, vaultKey: randomBytes(32) });

    expect(first).toBe(second);
    expect(first).toMatch(/^obj_[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(options.logicalId);
    expect(otherVault).not.toBe(first);
  });

  it("rejects a snapshot that is too large for the Firestore-only slice", async () => {
    const payload = snapshot();
    payload.conversations[0]!.messages[0]!.originalText = "x".repeat(460_000);
    await expect(encryptConversationSnapshot({
      prepared: { snapshot: payload, counts: measureConversationSnapshot(payload) },
      localVault: localVault(),
      vaultKey: randomBytes(32)
    })).rejects.toThrow("MIME/blob storage must be added first");
  });
});
