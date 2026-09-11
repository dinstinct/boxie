import {
  isConversationSnapshot,
  measureConversationSnapshot,
  type ConversationSnapshot,
  type ConversationSnapshotCounts
} from "../../contracts/conversations";
import {
  decryptJsonObject,
  deriveOpaqueObjectId,
  encryptJsonObject
} from "../vault-spike/crypto";
import type { EncryptedObject, LocalVaultState } from "../vault-spike/types";
import { CONVERSATION_SNAPSHOT_CONTENT_TYPE } from "../vault-spike/types";

export const MAX_FIRESTORE_SNAPSHOT_PLAINTEXT_BYTES = 450_000;

export interface PreparedConversationSnapshot {
  snapshot: ConversationSnapshot;
  counts: ConversationSnapshotCounts;
}

export interface EncryptedConversationSnapshot extends PreparedConversationSnapshot {
  objectId: string;
  encrypted: EncryptedObject;
}

export async function fetchConversationSnapshot(): Promise<PreparedConversationSnapshot> {
  const response = await fetch("/api/replication/conversation-snapshot", {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Conversation snapshot request failed (${response.status})`);
  }
  const snapshot: unknown = await response.json();
  if (!isConversationSnapshot(snapshot)) {
    throw new Error("Boxie's local server returned an unsupported conversation snapshot.");
  }
  return { snapshot, counts: measureConversationSnapshot(snapshot) };
}

export async function encryptConversationSnapshot(options: {
  prepared: PreparedConversationSnapshot;
  localVault: LocalVaultState;
  vaultKey: Uint8Array;
}): Promise<EncryptedConversationSnapshot> {
  if (options.prepared.counts.utf8Bytes > MAX_FIRESTORE_SNAPSHOT_PLAINTEXT_BYTES) {
    throw new Error(
      `This snapshot is ${options.prepared.counts.utf8Bytes.toLocaleString()} bytes; `
      + "the Firestore-only slice stops at 450,000 bytes. MIME/blob storage must be added first."
    );
  }
  const objectId = await deriveOpaqueObjectId({
    vaultKey: options.vaultKey,
    namespace: "conversation-snapshot",
    logicalId: "personal:v1"
  });
  const encrypted = await encryptJsonObject({
    vaultKey: options.vaultKey,
    vaultId: options.localVault.vaultId,
    objectId,
    epoch: options.localVault.epoch,
    contentType: CONVERSATION_SNAPSHOT_CONTENT_TYPE,
    payload: options.prepared.snapshot
  });
  return { ...options.prepared, objectId, encrypted };
}

export async function decryptConversationSnapshot(options: {
  encrypted: EncryptedObject;
  objectId: string;
  localVault: LocalVaultState;
  vaultKey: Uint8Array;
}): Promise<ConversationSnapshot> {
  const snapshot = await decryptJsonObject<unknown>({
    vaultKey: options.vaultKey,
    vaultId: options.localVault.vaultId,
    objectId: options.objectId,
    encrypted: options.encrypted,
    expectedContentType: CONVERSATION_SNAPSHOT_CONTENT_TYPE
  });
  if (!isConversationSnapshot(snapshot)) {
    throw new Error("The decrypted object is not a supported Boxie conversation snapshot.");
  }
  return snapshot;
}
