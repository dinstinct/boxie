import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions
} from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User
} from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
  type Unsubscribe
} from "firebase/firestore";
import type {
  EncryptedObject,
  LocalVaultState,
  RemotePairing,
  RemoteVaultRoot
} from "./types";
import { VAULT_SCHEMA_VERSION } from "./types";
import type {
  EncryptedObjectRecord,
  EncryptedObjectRepository
} from "../persistence/encrypted-object-repository";
import {
  runVaultResetBoundary,
  type VaultResetBoundaryResult
} from "./vault-reset-boundary";

export interface FirebaseSpikeClient {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  projectId: string;
}

export function readFirebaseOptions(): FirebaseOptions | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const appId = import.meta.env.VITE_FIREBASE_APP_ID?.trim();
  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }
  return { apiKey, authDomain, projectId, appId };
}

let singleton: FirebaseSpikeClient | null = null;
let authEmulatorConnected = false;

export function createFirebaseSpikeClient(): FirebaseSpikeClient | null {
  if (singleton) {
    return singleton;
  }
  const options = readFirebaseOptions();
  if (!options?.projectId) {
    return null;
  }
  const appName = "boxie-vault-spike";
  const app = getApps().some((candidate) => candidate.name === appName)
    ? getApp(appName)
    : initializeApp(options, appName);
  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: browserPopupRedirectResolver
    });
  } catch {
    auth = getAuth(app);
  }
  const authEmulatorHost = import.meta.env.VITE_BOXIE_AUTH_EMULATOR_HOST?.trim();
  if (authEmulatorHost && !authEmulatorConnected) {
    connectAuthEmulator(auth, `http://${authEmulatorHost}`, { disableWarnings: true });
    authEmulatorConnected = true;
  }
  void setPersistence(auth, browserLocalPersistence);
  let db: Firestore;
  try {db = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});}
  catch {db = getFirestore(app);}

  const emulatorHost = import.meta.env.VITE_BOXIE_FIRESTORE_EMULATOR_HOST?.trim();
  if (emulatorHost) {
    const separator = emulatorHost.lastIndexOf(":");
    const host = emulatorHost.slice(0, separator);
    const port = Number(emulatorHost.slice(separator + 1));
    if (!host || !Number.isInteger(port)) {
      throw new Error("VITE_BOXIE_FIRESTORE_EMULATOR_HOST must look like 127.0.0.1:8080");
    }
    connectFirestoreEmulator(db, host, port);
  }
  singleton = { app, auth, db, projectId: options.projectId };
  return singleton;
}

export function subscribeToUser(
  client: FirebaseSpikeClient,
  callback: (user: User | null) => void
): Unsubscribe {
  return onAuthStateChanged(client.auth, callback);
}

export async function signInWithGoogle(client: FirebaseSpikeClient): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return (await signInWithPopup(client.auth, provider)).user;
}

export async function signInWithEmulatorIdentity(client: FirebaseSpikeClient): Promise<User> {
  if (
    import.meta.env.VITE_BOXIE_SPIKE_ALLOW_EMULATOR_IDENTITY !== "true" ||
    !import.meta.env.VITE_BOXIE_AUTH_EMULATOR_HOST
  ) {
    throw new Error("The synthetic identity is available only with the local Auth emulator.");
  }
  const email = "boxie-vault-spike@example.invalid";
  const password = "boxie-synthetic-emulator-v1";
  try {
    return (await createUserWithEmailAndPassword(client.auth, email, password)).user;
  } catch (caught) {
    if (
      caught &&
      typeof caught === "object" &&
      "code" in caught &&
      String((caught as { code?: unknown }).code) === "auth/email-already-in-use"
    ) {
      return (await signInWithEmailAndPassword(client.auth, email, password)).user;
    }
    throw caught;
  }
}

export async function signOutUser(client: FirebaseSpikeClient): Promise<void> {
  await signOut(client.auth);
}

function rootRef(client: FirebaseSpikeClient, uid: string) {
  return doc(client.db, "boxie", uid);
}

function vaultRef(client: FirebaseSpikeClient, uid: string, vaultId: string) {
  return doc(client.db, "boxie", uid, "vaults", vaultId);
}

function deviceRef(client: FirebaseSpikeClient, uid: string, deviceId: string) {
  return doc(client.db, "boxie", uid, "devices", deviceId);
}

function pairingRef(client: FirebaseSpikeClient, uid: string, pairingId: string) {
  return doc(client.db, "boxie", uid, "pairings", pairingId);
}

function objectRef(
  client: FirebaseSpikeClient,
  uid: string,
  vaultId: string,
  objectId: string
) {
  return doc(client.db, "boxie", uid, "vaults", vaultId, "objects", objectId);
}

export async function getRemoteVaultRoot(
  client: FirebaseSpikeClient,
  uid: string
): Promise<RemoteVaultRoot | null> {
  const snapshot = await getDocFromServer(rootRef(client, uid));
  return snapshot.exists() ? snapshot.data() as RemoteVaultRoot : null;
}

export async function createRemoteVault(
  client: FirebaseSpikeClient,
  local: LocalVaultState
): Promise<void> {
  await runTransaction(client.db, async (transaction) => {
    const root = rootRef(client, local.uid);
    if ((await transaction.get(root)).exists()) {
      throw new Error("A Boxie vault already exists for this account. Pair this device instead.");
    }
    transaction.set(root, {
      schemaVersion: VAULT_SCHEMA_VERSION,
      activeVaultId: local.vaultId,
      epoch: local.epoch,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    transaction.set(vaultRef(client, local.uid, local.vaultId), {
      schemaVersion: VAULT_SCHEMA_VERSION,
      epoch: local.epoch,
      keyVersion: 1,
      status: "active",
      createdAt: serverTimestamp()
    });
    transaction.set(doc(client.db, "boxie", local.uid, "vaults", local.vaultId, "syncControl", "rollout"), {
      protocol: 2, epoch: local.epoch, phase: "preparing",
      migrationOwner: local.deviceId, updatedAt: serverTimestamp()
    });
    transaction.set(deviceRef(client, local.uid, local.deviceId), {
      schemaVersion: VAULT_SCHEMA_VERSION,
      vaultId: local.vaultId,
      epoch: local.epoch,
      name: local.deviceName,
      publicKeyJwk: local.devicePublicKeyJwk,
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp()
    });
  });
}

export async function touchDevice(
  client: FirebaseSpikeClient,
  local: LocalVaultState
): Promise<void> {
  await updateDoc(deviceRef(client, local.uid, local.deviceId), {
    lastSeenAt: serverTimestamp(),
    epoch: local.epoch,
    vaultId: local.vaultId
  });
}

export async function createRemotePairing(options: {
  client: FirebaseSpikeClient;
  uid: string;
  pairingId: string;
  vaultId: string;
  epoch: number;
  deviceId: string;
  deviceName: string;
  publicKeyJwk: JsonWebKey;
  safetyCode: string;
  expiresAt: Date;
}): Promise<void> {
  await setDoc(pairingRef(options.client, options.uid, options.pairingId), {
    schemaVersion: VAULT_SCHEMA_VERSION,
    vaultId: options.vaultId,
    epoch: options.epoch,
    requestingDeviceId: options.deviceId,
    requestingDeviceName: options.deviceName,
    requestingPublicKeyJwk: options.publicKeyJwk,
    safetyCode: options.safetyCode,
    expiresAt: options.expiresAt,
    status: "pending",
    createdAt: serverTimestamp()
  });
}

export async function getRemotePairing(
  client: FirebaseSpikeClient,
  uid: string,
  pairingId: string
): Promise<RemotePairing | null> {
  const snapshot = await getDoc(pairingRef(client, uid, pairingId));
  return snapshot.exists() ? snapshot.data() as RemotePairing : null;
}

export function subscribeRemotePairing(
  client: FirebaseSpikeClient,
  uid: string,
  pairingId: string,
  callback: (pairing: RemotePairing | null) => void,
  onError: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    pairingRef(client, uid, pairingId),
    (snapshot) => callback(snapshot.exists() ? snapshot.data() as RemotePairing : null),
    (error) => onError(error)
  );
}

export async function approveRemotePairing(options: {
  client: FirebaseSpikeClient;
  uid: string;
  pairingId: string;
  approvingDeviceId: string;
  senderPublicKeyJwk: JsonWebKey;
  salt: string;
  nonce: string;
  ciphertext: string;
}): Promise<void> {
  await runTransaction(options.client.db, async (transaction) => {
    const reference = pairingRef(options.client, options.uid, options.pairingId);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new Error("This pairing request no longer exists.");
    }
    const pairing = snapshot.data() as RemotePairing;
    if (pairing.status !== "pending") {
      throw new Error("This pairing request was already approved.");
    }
    transaction.update(reference, {
      status: "approved",
      approvingDeviceId: options.approvingDeviceId,
      senderPublicKeyJwk: options.senderPublicKeyJwk,
      salt: options.salt,
      nonce: options.nonce,
      ciphertext: options.ciphertext,
      approvedAt: serverTimestamp()
    });
  });
}

export async function registerPairedDevice(options: {
  client: FirebaseSpikeClient;
  local: LocalVaultState;
  pairingId: string;
}): Promise<void> {
  await setDoc(deviceRef(options.client, options.local.uid, options.local.deviceId), {
    schemaVersion: VAULT_SCHEMA_VERSION,
    vaultId: options.local.vaultId,
    epoch: options.local.epoch,
    name: options.local.deviceName,
    publicKeyJwk: options.local.devicePublicKeyJwk,
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp()
  });
  await deleteDoc(pairingRef(options.client, options.local.uid, options.pairingId));
}

export async function saveEncryptedObject(options: {
  client: FirebaseSpikeClient;
  uid: string;
  vaultId: string;
  objectId: string;
  encrypted: EncryptedObject;
}): Promise<void> {
  await setDoc(objectRef(
    options.client,
    options.uid,
    options.vaultId,
    options.objectId
  ), {
    ...options.encrypted,
    createdAt: serverTimestamp()
  });
}

export async function listEncryptedObjects(options: {
  client: FirebaseSpikeClient;
  uid: string;
  vaultId: string;
}): Promise<Array<{ id: string; encrypted: EncryptedObject }>> {
  const snapshot = await getDocs(collection(
    options.client.db,
    "boxie",
    options.uid,
    "vaults",
    options.vaultId,
    "objects"
  ));
  return snapshot.docs.map((item) => ({
    id: item.id,
    encrypted: item.data() as EncryptedObject
  }));
}

export class FirebaseEncryptedObjectRepository implements EncryptedObjectRepository {
  constructor(
    private readonly client: FirebaseSpikeClient,
    private readonly uid: string,
    private readonly vaultId: string
  ) {}

  async put(record: EncryptedObjectRecord): Promise<void> {
    await saveEncryptedObject({
      client: this.client,
      uid: this.uid,
      vaultId: this.vaultId,
      objectId: record.objectId,
      encrypted: record.encrypted
    });
  }

  async get(objectId: string): Promise<EncryptedObjectRecord | null> {
    const snapshot = await getDoc(objectRef(
      this.client,
      this.uid,
      this.vaultId,
      objectId
    ));
    return snapshot.exists()
      ? { objectId, encrypted: snapshot.data() as EncryptedObject }
      : null;
  }

  async list(): Promise<EncryptedObjectRecord[]> {
    return listEncryptedObjects({
      client: this.client,
      uid: this.uid,
      vaultId: this.vaultId
    }).then((rows) => rows.map((row) => ({
      objectId: row.id,
      encrypted: row.encrypted
    })));
  }

  async delete(objectId: string): Promise<void> {
    await deleteDoc(objectRef(
      this.client,
      this.uid,
      this.vaultId,
      objectId
    ));
  }
}

export async function resetRemoteVault(options: {
  client: FirebaseSpikeClient;
  previousRoot: RemoteVaultRoot;
  replacement: LocalVaultState;
}): Promise<VaultResetBoundaryResult> {
  const { client, previousRoot, replacement } = options;
  if (replacement.epoch !== previousRoot.epoch + 1) {
    throw new Error("A reset must advance the vault epoch exactly once.");
  }
  return runVaultResetBoundary({
    commit: async () => {
      await runTransaction(client.db, async (transaction) => {
        const root = rootRef(client, replacement.uid);
        const current = await transaction.get(root);
        if (!current.exists() || (current.data() as RemoteVaultRoot).epoch !== previousRoot.epoch) {
          throw new Error("The remote vault changed while reset was being prepared.");
        }
        transaction.update(root, {
          activeVaultId: replacement.vaultId,
          epoch: replacement.epoch,
          updatedAt: serverTimestamp()
        });
        transaction.set(vaultRef(client, replacement.uid, replacement.vaultId), {
          schemaVersion: VAULT_SCHEMA_VERSION,
          epoch: replacement.epoch,
          keyVersion: 1,
          status: "active",
          createdAt: serverTimestamp()
        });
        transaction.set(deviceRef(client, replacement.uid, replacement.deviceId), {
          schemaVersion: VAULT_SCHEMA_VERSION,
          vaultId: replacement.vaultId,
          epoch: replacement.epoch,
          name: replacement.deviceName,
          publicKeyJwk: replacement.devicePublicKeyJwk,
          createdAt: serverTimestamp(),
          lastSeenAt: serverTimestamp()
        });
      });
    },
    cleanup: async () => {
      const [pairings, devices, vaults] = await Promise.all([
        getDocs(collection(client.db, "boxie", replacement.uid, "pairings")),
        getDocs(collection(client.db, "boxie", replacement.uid, "devices")),
        getDocs(collection(client.db, "boxie", replacement.uid, "vaults"))
      ]);
      await Promise.all(pairings.docs.map((item) => deleteDoc(item.ref)));
      await Promise.all(devices.docs
        .filter((item) => item.id !== replacement.deviceId)
        .map((item) => deleteDoc(item.ref)));
      for (const vault of vaults.docs) {
        if (vault.id === replacement.vaultId) {
          continue;
        }
        const [objects, canonical] = await Promise.all([
          getDocs(collection(vault.ref, "objects")),
          getDocs(collection(vault.ref, "canonical"))
        ]);
        await Promise.all(objects.docs.map((item) => deleteDoc(item.ref)));
        for (const item of canonical.docs) {
          const chunks = await getDocs(collection(item.ref, "chunks"));
          await Promise.all(chunks.docs.map((chunk) => deleteDoc(chunk.ref)));
          await deleteDoc(item.ref);
        }
        await deleteDoc(vault.ref);
      }
    }
  });
}
