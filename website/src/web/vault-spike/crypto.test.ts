import { describe, expect, it } from "vitest";
import {
  createDeviceWrappingKey,
  createSafetyCode,
  decodePairingPayload,
  decryptSyntheticObject,
  encodePairingPayload,
  encryptSyntheticObject,
  generateDeviceKeyPair,
  randomBytes,
  unwrapVaultKeyFromPairing,
  unwrapVaultKeyLocally,
  wrapVaultKeyForPairing,
  wrapVaultKeyLocally
} from "./crypto";
import type { PairingQrPayload, SyntheticPayload } from "./types";

describe("encrypted vault spike crypto", () => {
  it("round-trips a per-object encrypted payload without cloud plaintext", async () => {
    const vaultKey = randomBytes(32);
    const payload: SyntheticPayload = {
      kind: "boxie-synthetic-vault-spike",
      message: "Synthetic secret that must not appear in the cloud document.",
      createdAt: "2026-08-30T12:00:00.000Z"
    };
    const encrypted = await encryptSyntheticObject({
      vaultKey,
      vaultId: "vault-test",
      objectId: "object-test",
      epoch: 3,
      payload
    });

    const cloudDocument = JSON.stringify(encrypted);
    expect(cloudDocument).not.toContain(payload.message);
    expect(cloudDocument).not.toContain(payload.kind);
    await expect(decryptSyntheticObject({
      vaultKey,
      vaultId: "vault-test",
      objectId: "object-test",
      encrypted
    })).resolves.toEqual(payload);
  });

  it("moves the vault key through an authenticated one-time ECDH envelope", async () => {
    const recipient = await generateDeviceKeyPair();
    const vaultKey = randomBytes(32);
    const context = {
      uid: "alice",
      pairingId: "pair-test",
      vaultId: "vault-test",
      epoch: 7,
      deviceId: "device-new"
    };
    const envelope = await wrapVaultKeyForPairing({
      ...context,
      vaultKey,
      recipientPublicKeyJwk: recipient.publicKeyJwk
    });
    const recovered = await unwrapVaultKeyFromPairing({
      ...context,
      envelope,
      recipientPrivateKey: recipient.privateKey
    });

    expect([...recovered]).toEqual([...vaultKey]);
    expect(JSON.stringify(envelope)).not.toContain(String(vaultKey));
    await expect(unwrapVaultKeyFromPairing({
      ...context,
      epoch: 8,
      envelope,
      recipientPrivateKey: recipient.privateKey
    })).rejects.toThrow();
  });

  it("stores the local vault key under a non-exportable device wrapping key", async () => {
    const wrappingKey = await createDeviceWrappingKey();
    expect(wrappingKey.extractable).toBe(false);
    const vaultKey = randomBytes(32);
    const context = {
      uid: "alice",
      vaultId: "vault-local",
      epoch: 1,
      deviceId: "device-local"
    };
    const wrapped = await wrapVaultKeyLocally({ wrappingKey, vaultKey, ...context });
    const recovered = await unwrapVaultKeyLocally({
      wrappingKey,
      nonce: wrapped.nonce,
      ciphertext: wrapped.ciphertext,
      ...context
    });
    expect([...recovered]).toEqual([...vaultKey]);
  });

  it("makes a stable human-comparable safety code from the requesting key", async () => {
    const recipient = await generateDeviceKeyPair();
    const options = {
      pairingId: "pair-code",
      deviceId: "device-code",
      publicKeyJwk: recipient.publicKeyJwk
    };
    const first = await createSafetyCode(options);
    const second = await createSafetyCode(options);
    const reordered = await createSafetyCode({
      ...options,
      publicKeyJwk: {
        y: recipient.publicKeyJwk.y!,
        x: recipient.publicKeyJwk.x!,
        crv: recipient.publicKeyJwk.crv!,
        kty: recipient.publicKeyJwk.kty!
      }
    });
    expect(first).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    expect(second).toBe(first);
    expect(reordered).toBe(first);
  });

  it("encodes a project-bound pairing request in either a QR value or URL", () => {
    const payload: PairingQrPayload = {
      kind: "boxie-device-pairing",
      version: 1,
      pairingId: "pair-url",
      projectId: "dionlabs-fe92e"
    };
    const encoded = encodePairingPayload(payload);
    expect(decodePairingPayload(encoded)).toEqual(payload);
    expect(decodePairingPayload(
      `https://boxie.dionlabs.ai/?vaultSpike=1&pairing=${encodeURIComponent(encoded)}`
    )).toEqual(payload);
  });
});
