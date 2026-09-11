import { openDB, type DBSchema } from "idb";
import {
  createDeviceWrappingKey,
  generateDeviceKeyPair,
  randomId,
  unwrapVaultKeyLocally,
  wrapVaultKeyLocally
} from "./crypto";
import type { LocalVaultState, PendingPairingState } from "./types";
import { VAULT_SCHEMA_VERSION } from "./types";

interface VaultSpikeDatabase extends DBSchema {
  vaults: {
    key: string;
    value: LocalVaultState;
  };
  pairings: {
    key: string;
    value: PendingPairingState;
  };
}

const databasePromise = openDB<VaultSpikeDatabase>("boxie-vault-spike-v1", 1, {
  upgrade(database) {
    database.createObjectStore("vaults");
    database.createObjectStore("pairings");
  }
});

function pairingKey(uid: string, pairingId: string): string {
  return `${uid}:${pairingId}`;
}

export async function loadLocalVault(uid: string): Promise<LocalVaultState | null> {
  return (await databasePromise).get("vaults", uid).then((value) => value ?? null);
}

export async function deleteLocalVault(uid: string): Promise<void> {
  await (await databasePromise).delete("vaults", uid);
}

export async function deleteLocalPairings(uid: string): Promise<void> {
  const database = await databasePromise;
  const transaction = database.transaction("pairings", "readwrite");
  const pairings = transaction.objectStore("pairings");
  for (const key of await pairings.getAllKeys()) {
    if (key.startsWith(`${uid}:`)) {
      await pairings.delete(key);
    }
  }
  await transaction.done;
}

export async function saveLocalVaultState(state: LocalVaultState): Promise<void> {
  await (await databasePromise).put("vaults", state, state.uid);
}

export async function createAndSaveLocalVault(options: {
  uid: string;
  vaultId: string;
  epoch: number;
  vaultKey: Uint8Array;
  deviceName: string;
  deviceId?: string;
  devicePrivateKey?: CryptoKey;
  devicePublicKeyJwk?: JsonWebKey;
}): Promise<LocalVaultState> {
  const generatedPair = options.devicePrivateKey && options.devicePublicKeyJwk
    ? null
    : await generateDeviceKeyPair();
  const deviceId = options.deviceId ?? randomId("device");
  const wrappingKey = await createDeviceWrappingKey();
  const wrapped = await wrapVaultKeyLocally({
    wrappingKey,
    vaultKey: options.vaultKey,
    uid: options.uid,
    vaultId: options.vaultId,
    epoch: options.epoch,
    deviceId
  });
  const state: LocalVaultState = {
    schemaVersion: VAULT_SCHEMA_VERSION,
    uid: options.uid,
    vaultId: options.vaultId,
    epoch: options.epoch,
    deviceId,
    deviceName: options.deviceName,
    devicePrivateKey: options.devicePrivateKey ?? generatedPair!.privateKey,
    devicePublicKeyJwk: options.devicePublicKeyJwk ?? generatedPair!.publicKeyJwk,
    deviceWrappingKey: wrappingKey,
    wrappedVaultKeyNonce: wrapped.nonce,
    wrappedVaultKey: wrapped.ciphertext,
    createdAt: Date.now()
  };
  await saveLocalVaultState(state);
  return state;
}

export async function readLocalVaultKey(state: LocalVaultState): Promise<Uint8Array<ArrayBuffer>> {
  return unwrapVaultKeyLocally({
    wrappingKey: state.deviceWrappingKey,
    nonce: state.wrappedVaultKeyNonce,
    ciphertext: state.wrappedVaultKey,
    uid: state.uid,
    vaultId: state.vaultId,
    epoch: state.epoch,
    deviceId: state.deviceId
  });
}

export async function savePendingPairing(state: PendingPairingState): Promise<void> {
  await (await databasePromise).put(
    "pairings",
    state,
    pairingKey(state.uid, state.pairingId)
  );
}

export async function loadPendingPairing(
  uid: string,
  pairingId: string
): Promise<PendingPairingState | null> {
  return (await databasePromise)
    .get("pairings", pairingKey(uid, pairingId))
    .then((value) => value ?? null);
}

export async function deletePendingPairing(uid: string, pairingId: string): Promise<void> {
  await (await databasePromise).delete("pairings", pairingKey(uid, pairingId));
}

/** Device-local discovery only; no cloud authentication or writes. */
export async function hasSavedCloudVault(): Promise<boolean> {
  return (await (await databasePromise).getAllKeys("vaults")).some(uid => !uid.startsWith("local-outlook-"));
}
