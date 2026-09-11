export const VAULT_SCHEMA_VERSION = 1;
export const SYNTHETIC_CONTENT_TYPE = "application/vnd.boxie.synthetic+json";
export const CONVERSATION_SNAPSHOT_CONTENT_TYPE =
  "application/vnd.boxie.conversation-snapshot+json";
export const CANONICAL_MAILBOX_CONTENT_TYPE =
  "application/vnd.boxie.canonical-mailbox+json";
export const CANONICAL_MESSAGE_CONTENT_TYPE =
  "application/vnd.boxie.canonical-message+json";

export type EncryptedJsonContentType =
  | typeof SYNTHETIC_CONTENT_TYPE
  | typeof CONVERSATION_SNAPSHOT_CONTENT_TYPE
  | typeof CANONICAL_MAILBOX_CONTENT_TYPE
  | typeof CANONICAL_MESSAGE_CONTENT_TYPE
  | "application/vnd.boxie.sync-v2+json";

export interface RemoteVaultRoot {
  schemaVersion: 1;
  activeVaultId: string;
  epoch: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RemoteVault {
  schemaVersion: 1;
  epoch: number;
  keyVersion: number;
  status: "active";
  createdAt?: unknown;
}

export interface RemoteDevice {
  schemaVersion: 1;
  vaultId: string;
  epoch: number;
  name: string;
  publicKeyJwk: JsonWebKey;
  createdAt?: unknown;
  lastSeenAt?: unknown;
}

export interface PairingEnvelope {
  senderPublicKeyJwk: JsonWebKey;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface RemotePairing {
  schemaVersion: 1;
  vaultId: string;
  epoch: number;
  requestingDeviceId: string;
  requestingDeviceName: string;
  requestingPublicKeyJwk: JsonWebKey;
  safetyCode: string;
  expiresAt: unknown;
  status: "pending" | "approved";
  createdAt?: unknown;
  approvingDeviceId?: string;
  senderPublicKeyJwk?: JsonWebKey;
  salt?: string;
  nonce?: string;
  ciphertext?: string;
  approvedAt?: unknown;
}

export interface EncryptedObject {
  schemaVersion: 1;
  epoch: number;
  algorithm: "AES-256-GCM";
  contentType: EncryptedJsonContentType;
  nonce: string;
  ciphertext: string;
  wrappedKeyNonce: string;
  wrappedKey: string;
  createdAt?: unknown;
}

export interface LocalVaultState {
  schemaVersion: 1;
  uid: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
  deviceName: string;
  devicePrivateKey: CryptoKey;
  devicePublicKeyJwk: JsonWebKey;
  deviceWrappingKey: CryptoKey;
  wrappedVaultKeyNonce: string;
  wrappedVaultKey: string;
  createdAt: number;
}

export interface PendingPairingState {
  schemaVersion: 1;
  uid: string;
  pairingId: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
  deviceName: string;
  devicePrivateKey: CryptoKey;
  devicePublicKeyJwk: JsonWebKey;
  safetyCode: string;
  createdAt: number;
}

export interface SyntheticPayload {
  kind: "boxie-synthetic-vault-spike";
  message: string;
  createdAt: string;
}

export interface PairingQrPayload {
  kind: "boxie-device-pairing";
  version: 1;
  pairingId: string;
  projectId: string;
}
