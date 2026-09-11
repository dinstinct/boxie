import type {
  EncryptedObject,
  EncryptedJsonContentType,
  PairingEnvelope,
  PairingQrPayload,
  SyntheticPayload
} from "./types";
import { SYNTHETIC_CONTENT_TYPE, VAULT_SCHEMA_VERSION } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable. Use a secure HTTPS origin or localhost.");
  }
  return globalThis.crypto;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

export function randomId(prefix: string): string {
  return `${prefix}_${webCrypto().randomUUID().replaceAll("-", "")}`;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function aad(...parts: Array<string | number>): Uint8Array<ArrayBuffer> {
  return encoder.encode(parts.join("|"));
}

async function importAesKey(
  bytes: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    "raw",
    asBuffer(bytes),
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function generateDeviceKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const pair = await webCrypto().subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  ) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKeyJwk: await webCrypto().subtle.exportKey("jwk", pair.publicKey)
  };
}

async function importEcdhPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function derivePairingKey(options: {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  salt: Uint8Array;
  pairingId: string;
}): Promise<CryptoKey> {
  const publicKey = await importEcdhPublicKey(options.publicKeyJwk);
  const sharedBits = await webCrypto().subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    options.privateKey,
    256
  );
  const keyMaterial = await webCrypto().subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return webCrypto().subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asBuffer(options.salt),
      info: asBuffer(aad("boxie-pairing-key", VAULT_SCHEMA_VERSION, options.pairingId))
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function pairingAad(options: {
  uid: string;
  pairingId: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Uint8Array<ArrayBuffer> {
  return aad(
    "boxie-pairing-envelope",
    VAULT_SCHEMA_VERSION,
    options.uid,
    options.pairingId,
    options.vaultId,
    options.epoch,
    options.deviceId
  );
}

export async function wrapVaultKeyForPairing(options: {
  vaultKey: Uint8Array;
  recipientPublicKeyJwk: JsonWebKey;
  uid: string;
  pairingId: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Promise<PairingEnvelope> {
  const sender = await generateDeviceKeyPair();
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await derivePairingKey({
    privateKey: sender.privateKey,
    publicKeyJwk: options.recipientPublicKeyJwk,
    salt,
    pairingId: options.pairingId
  });
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(nonce),
      additionalData: asBuffer(pairingAad(options)),
      tagLength: 128
    },
    key,
    asBuffer(options.vaultKey)
  );
  return {
    senderPublicKeyJwk: sender.publicKeyJwk,
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export async function unwrapVaultKeyFromPairing(options: {
  envelope: PairingEnvelope;
  recipientPrivateKey: CryptoKey;
  uid: string;
  pairingId: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const salt = base64UrlToBytes(options.envelope.salt);
  const key = await derivePairingKey({
    privateKey: options.recipientPrivateKey,
    publicKeyJwk: options.envelope.senderPublicKeyJwk,
    salt,
    pairingId: options.pairingId
  });
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(base64UrlToBytes(options.envelope.nonce)),
      additionalData: asBuffer(pairingAad(options)),
      tagLength: 128
    },
    key,
    asBuffer(base64UrlToBytes(options.envelope.ciphertext))
  );
  return new Uint8Array(plaintext);
}

function objectAad(options: {
  vaultId: string;
  objectId: string;
  epoch: number;
  purpose: "content" | "data-key";
}): Uint8Array<ArrayBuffer> {
  return aad(
    "boxie-encrypted-object",
    VAULT_SCHEMA_VERSION,
    options.vaultId,
    options.objectId,
    options.epoch,
    options.purpose
  );
}

export async function deriveOpaqueObjectId(options: {
  vaultKey: Uint8Array;
  namespace: string;
  logicalId: string;
}): Promise<string> {
  const key = await webCrypto().subtle.importKey(
    "raw",
    asBuffer(options.vaultKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await webCrypto().subtle.sign(
    "HMAC",
    key,
    asBuffer(aad(
      "boxie-opaque-object-id",
      VAULT_SCHEMA_VERSION,
      options.namespace,
      options.logicalId
    ))
  );
  return `obj_${bytesToBase64Url(new Uint8Array(digest))}`;
}

export async function encryptJsonObject<T>(options: {
  vaultKey: Uint8Array;
  vaultId: string;
  objectId: string;
  epoch: number;
  contentType: EncryptedJsonContentType;
  payload: T;
}): Promise<EncryptedObject> {
  const dataKeyBytes = randomBytes(32);
  const dataKey = await importAesKey(dataKeyBytes, ["encrypt"]);
  const vaultKey = await importAesKey(options.vaultKey, ["encrypt"]);
  const nonce = randomBytes(12);
  const wrappedKeyNonce = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(options.payload));

  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(nonce),
      additionalData: asBuffer(objectAad({ ...options, purpose: "content" })),
      tagLength: 128
    },
    dataKey,
    asBuffer(plaintext)
  );
  const wrappedKey = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(wrappedKeyNonce),
      additionalData: asBuffer(objectAad({ ...options, purpose: "data-key" })),
      tagLength: 128
    },
    vaultKey,
    asBuffer(dataKeyBytes)
  );

  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    epoch: options.epoch,
    algorithm: "AES-256-GCM",
    contentType: options.contentType,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    wrappedKeyNonce: bytesToBase64Url(wrappedKeyNonce),
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey))
  };
}

export async function decryptJsonObject<T>(options: {
  vaultKey: Uint8Array;
  vaultId: string;
  objectId: string;
  encrypted: EncryptedObject;
  expectedContentType: EncryptedJsonContentType;
}): Promise<T> {
  if (options.encrypted.contentType !== options.expectedContentType) {
    throw new Error(`Encrypted object has unexpected content type ${options.encrypted.contentType}`);
  }
  const vaultKey = await importAesKey(options.vaultKey, ["decrypt"]);
  const wrappedDataKey = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(base64UrlToBytes(options.encrypted.wrappedKeyNonce)),
      additionalData: asBuffer(objectAad({
        ...options,
        epoch: options.encrypted.epoch,
        purpose: "data-key"
      })),
      tagLength: 128
    },
    vaultKey,
    asBuffer(base64UrlToBytes(options.encrypted.wrappedKey))
  );
  const dataKey = await importAesKey(new Uint8Array(wrappedDataKey), ["decrypt"]);
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(base64UrlToBytes(options.encrypted.nonce)),
      additionalData: asBuffer(objectAad({
        ...options,
        epoch: options.encrypted.epoch,
        purpose: "content"
      })),
      tagLength: 128
    },
    dataKey,
    asBuffer(base64UrlToBytes(options.encrypted.ciphertext))
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function encryptSyntheticObject(options: {
  vaultKey: Uint8Array;
  vaultId: string;
  objectId: string;
  epoch: number;
  payload: SyntheticPayload;
}): Promise<EncryptedObject> {
  return encryptJsonObject({
    ...options,
    contentType: SYNTHETIC_CONTENT_TYPE
  });
}

export async function decryptSyntheticObject(options: {
  vaultKey: Uint8Array;
  vaultId: string;
  objectId: string;
  encrypted: EncryptedObject;
}): Promise<SyntheticPayload> {
  return decryptJsonObject<SyntheticPayload>({
    ...options,
    expectedContentType: SYNTHETIC_CONTENT_TYPE
  });
}

export async function createSafetyCode(options: {
  pairingId: string;
  deviceId: string;
  publicKeyJwk: JsonWebKey;
}): Promise<string> {
  const canonicalPublicKey = {
    kty: options.publicKeyJwk.kty ?? null,
    crv: options.publicKeyJwk.crv ?? null,
    x: options.publicKeyJwk.x ?? null,
    y: options.publicKeyJwk.y ?? null
  };
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    asBuffer(encoder.encode(JSON.stringify({
      pairingId: options.pairingId,
      deviceId: options.deviceId,
      publicKeyJwk: canonicalPublicKey
    })))
  );
  const hex = [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function encodePairingPayload(payload: PairingQrPayload): string {
  return `boxie-pairing:${bytesToBase64Url(encoder.encode(JSON.stringify(payload)))}`;
}

export function decodePairingPayload(value: string): PairingQrPayload {
  const candidate = (() => {
    try {
      const url = new URL(value);
      return url.searchParams.get("pairing") ?? value;
    } catch {
      return value;
    }
  })();
  if (!candidate.startsWith("boxie-pairing:")) {
    throw new Error("This is not a Boxie pairing code.");
  }
  const decoded = JSON.parse(decoder.decode(
    base64UrlToBytes(candidate.slice("boxie-pairing:".length))
  )) as Partial<PairingQrPayload>;
  if (
    decoded.kind !== "boxie-device-pairing" ||
    decoded.version !== 1 ||
    typeof decoded.pairingId !== "string" ||
    typeof decoded.projectId !== "string"
  ) {
    throw new Error("The Boxie pairing code is malformed or unsupported.");
  }
  return decoded as PairingQrPayload;
}

export async function createDeviceWrappingKey(): Promise<CryptoKey> {
  return webCrypto().subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function localVaultAad(options: {
  uid: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Uint8Array<ArrayBuffer> {
  return aad(
    "boxie-local-vault",
    VAULT_SCHEMA_VERSION,
    options.uid,
    options.vaultId,
    options.epoch,
    options.deviceId
  );
}

export async function wrapVaultKeyLocally(options: {
  wrappingKey: CryptoKey;
  vaultKey: Uint8Array;
  uid: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = randomBytes(12);
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(nonce),
      additionalData: asBuffer(localVaultAad(options)),
      tagLength: 128
    },
    options.wrappingKey,
    asBuffer(options.vaultKey)
  );
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export async function unwrapVaultKeyLocally(options: {
  wrappingKey: CryptoKey;
  nonce: string;
  ciphertext: string;
  uid: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asBuffer(base64UrlToBytes(options.nonce)),
      additionalData: asBuffer(localVaultAad(options)),
      tagLength: 128
    },
    options.wrappingKey,
    asBuffer(base64UrlToBytes(options.ciphertext))
  );
  return new Uint8Array(plaintext);
}
