import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Trash2,
  X
} from "lucide-react";
import QRCode from "qrcode";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { User } from "firebase/auth";
import type {
  ConversationSnapshot,
  ConversationSnapshotCounts
} from "../../contracts/conversations";
import {
  decryptConversationSnapshot,
  encryptConversationSnapshot,
  fetchConversationSnapshot,
  type PreparedConversationSnapshot
} from "../persistence/conversation-snapshot-replication";
import { deleteIndexedDbCanonicalVault } from "../mail/encrypted-canonical-repository";
import {
  deleteIndexedDbEncryptedObjectVault,
  IndexedDbEncryptedObjectRepository
} from "../persistence/indexeddb-encrypted-object-repository";
import {
  createSafetyCode,
  decodePairingPayload,
  decryptSyntheticObject,
  encodePairingPayload,
  encryptSyntheticObject,
  generateDeviceKeyPair,
  randomBytes,
  randomId,
  unwrapVaultKeyFromPairing,
  wrapVaultKeyForPairing
} from "./crypto";
import {
  approveRemotePairing,
  createFirebaseSpikeClient,
  createRemotePairing,
  createRemoteVault,
  getRemotePairing,
  getRemoteVaultRoot,
  FirebaseEncryptedObjectRepository,
  listEncryptedObjects,
  registerPairedDevice,
  resetRemoteVault,
  saveEncryptedObject,
  signInWithEmulatorIdentity,
  signInWithGoogle,
  signOutUser,
  subscribeRemotePairing,
  subscribeToUser,
  touchDevice,
  type FirebaseSpikeClient
} from "./firebase-client";
import {
  createAndSaveLocalVault,
  deleteLocalPairings,
  deleteLocalVault,
  deletePendingPairing,
  loadLocalVault,
  loadPendingPairing,
  readLocalVaultKey,
  saveLocalVaultState,
  savePendingPairing
} from "./local-store";
import type {
  EncryptedObject,
  LocalVaultState,
  PairingQrPayload,
  PendingPairingState,
  RemotePairing,
  RemoteVaultRoot,
  SyntheticPayload
} from "./types";
import {
  CONVERSATION_SNAPSHOT_CONTENT_TYPE,
  SYNTHETIC_CONTENT_TYPE,
  VAULT_SCHEMA_VERSION
} from "./types";
import "./vault-spike.css";

type LoadingValue<T> = T | null | undefined;

interface CloudObjectRow {
  id: string;
  encrypted: EncryptedObject;
}

const RESET_PHRASE = "RESET BOXIE VAULT";

function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes("Mac")
    ? "Mac"
    : navigator.userAgent.includes("iPhone")
      ? "iPhone"
      : navigator.userAgent.includes("Android")
        ? "Android"
        : "Browser";
  const browser = navigator.userAgent.includes("Firefox")
    ? "Firefox"
    : navigator.userAgent.includes("Edg/")
      ? "Edge"
      : navigator.userAgent.includes("Chrome")
        ? "Chrome"
        : navigator.userAgent.includes("Safari")
          ? "Safari"
          : "device";
  return `${platform} · ${browser}`;
}

function expiresAtMillis(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      return Number(toMillis.call(value));
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "auth/unauthorized-domain"
  ) {
    return "Firebase does not authorize this hostname. For local testing, open Boxie at http://localhost:5174.";
  }
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function snapshotCounts(snapshot: ConversationSnapshot): ConversationSnapshotCounts {
  return {
    conversations: snapshot.conversations.length,
    messages: snapshot.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0
    ),
    utf8Bytes: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
  };
}

function ciphertextExcludesConversationPlaintext(
  encrypted: EncryptedObject,
  snapshot: ConversationSnapshot
): boolean {
  const serialized = JSON.stringify(encrypted);
  const probes = snapshot.conversations.flatMap((conversation) => [
    conversation.name,
    ...conversation.messages.flatMap((message) => [
      message.subject,
      message.originalText,
      message.authorName
    ])
  ]).filter((value) => value.length >= 4);
  return probes.every((value) => !serialized.includes(value));
}

function pairingEnvelope(pairing: RemotePairing) {
  if (
    !pairing.senderPublicKeyJwk ||
    !pairing.salt ||
    !pairing.nonce ||
    !pairing.ciphertext
  ) {
    throw new Error("The approved pairing envelope is incomplete.");
  }
  return {
    senderPublicKeyJwk: pairing.senderPublicKeyJwk,
    salt: pairing.salt,
    nonce: pairing.nonce,
    ciphertext: pairing.ciphertext
  };
}

export function VaultSpikeApp() {
  const client = useMemo(() => createFirebaseSpikeClient(), []);
  const recoveryRequested = useMemo(
    () => new URLSearchParams(window.location.search).get("recovery") === "1",
    []
  );
  const pairingRequestFromUrl = useMemo(
    () => new URLSearchParams(window.location.search).get("pairing"),
    []
  );
  const [user, setUser] = useState<LoadingValue<User>>(undefined);
  const [remoteRoot, setRemoteRoot] = useState<LoadingValue<RemoteVaultRoot>>(undefined);
  const [localVault, setLocalVault] = useState<LoadingValue<LocalVaultState>>(undefined);
  const [pendingPairing, setPendingPairing] = useState<PendingPairingState | null>(null);
  const [approvalPairing, setApprovalPairing] = useState<RemotePairing | null>(null);
  const [approvalPairingId, setApprovalPairingId] = useState<string | null>(null);
  const [pairingQrUrl, setPairingQrUrl] = useState<string | null>(null);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [pairingInput, setPairingInput] = useState(pairingRequestFromUrl ?? "");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [objects, setObjects] = useState<CloudObjectRow[]>([]);
  const [decrypted, setDecrypted] = useState<Record<string, SyntheticPayload>>({});
  const [cloudInspection, setCloudInspection] = useState<{
    objectId: string;
    encrypted: EncryptedObject;
    plaintextAbsent: boolean;
  } | null>(null);
  const [preparedConversationSnapshot, setPreparedConversationSnapshot] =
    useState<PreparedConversationSnapshot | null>(null);
  const [conversationSnapshotProof, setConversationSnapshotProof] = useState<{
    objectId: string;
    exportedAt: string;
    counts: ConversationSnapshotCounts;
  } | null>(null);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [resetPhrase, setResetPhrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const consumingPairingRef = useRef<string | null>(null);
  const loadedApprovalDeepLinkRef = useRef<string | null>(null);

  const refresh = useCallback(async (activeUser: User, activeClient: FirebaseSpikeClient) => {
    const [root, local] = await Promise.all([
      getRemoteVaultRoot(activeClient, activeUser.uid),
      loadLocalVault(activeUser.uid)
    ]);
    setRemoteRoot(root);
    setLocalVault(local);
    if (root && local && root.epoch === local.epoch && root.activeVaultId === local.vaultId) {
      await touchDevice(activeClient, local).catch(() => undefined);
      setObjects(await listEncryptedObjects({
        client: activeClient,
        uid: activeUser.uid,
        vaultId: local.vaultId
      }));
    } else {
      setObjects([]);
    }
  }, []);

  useEffect(() => {
    if (!client) {
      setUser(null);
      return;
    }
    return subscribeToUser(client, (nextUser) => {
      setUser(nextUser);
      setRemoteRoot(nextUser ? undefined : null);
      setLocalVault(nextUser ? undefined : null);
      setPendingPairing(null);
      setApprovalPairing(null);
      setPreparedConversationSnapshot(null);
      setConversationSnapshotProof(null);
      setError(null);
      if (nextUser) {
        void refresh(nextUser, client).catch((caught) => setError(errorMessage(caught)));
      }
    });
  }, [client, refresh]);

  useEffect(() => {
    if (!client || !user || !remoteRoot || !pairingRequestFromUrl) {
      return;
    }
    try {
      const payload = decodePairingPayload(pairingRequestFromUrl);
      if (payload.projectId !== client.projectId) {
        throw new Error("This pairing request belongs to a different Firebase project.");
      }
      if (localVault === null) {
        void loadPendingPairing(user.uid, payload.pairingId).then((pending) => {
          if (pending) {
            setPendingPairing(pending);
          }
        });
        return;
      }
      if (loadedApprovalDeepLinkRef.current === payload.pairingId) {
        return;
      }
      loadedApprovalDeepLinkRef.current = payload.pairingId;
      void run("Loading pairing", () => loadApproval(pairingRequestFromUrl));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [client, localVault, pairingRequestFromUrl, remoteRoot, user]);

  const consumeApprovedPairing = useCallback(async (
    activeClient: FirebaseSpikeClient,
    activeUser: User,
    pending: PendingPairingState,
    pairing: RemotePairing
  ) => {
    if (consumingPairingRef.current === pending.pairingId) {
      return;
    }
    consumingPairingRef.current = pending.pairingId;
    setBusy("Unlocking this device");
    try {
      if (
        pairing.vaultId !== pending.vaultId ||
        pairing.epoch !== pending.epoch ||
        pairing.requestingDeviceId !== pending.deviceId ||
        pairing.safetyCode !== pending.safetyCode
      ) {
        throw new Error("The approved pairing does not match this device request.");
      }
      const vaultKey = await unwrapVaultKeyFromPairing({
        envelope: pairingEnvelope(pairing),
        recipientPrivateKey: pending.devicePrivateKey,
        uid: activeUser.uid,
        pairingId: pending.pairingId,
        vaultId: pending.vaultId,
        epoch: pending.epoch,
        deviceId: pending.deviceId
      });
      const local = await createAndSaveLocalVault({
        uid: activeUser.uid,
        vaultId: pending.vaultId,
        epoch: pending.epoch,
        vaultKey,
        deviceName: pending.deviceName,
        deviceId: pending.deviceId,
        devicePrivateKey: pending.devicePrivateKey,
        devicePublicKeyJwk: pending.devicePublicKeyJwk
      });
      await registerPairedDevice({
        client: activeClient,
        local,
        pairingId: pending.pairingId
      });
      await deletePendingPairing(activeUser.uid, pending.pairingId);
      setPendingPairing(null);
      setPairingQrUrl(null);
      setPairingLink(null);
      setNotice("This device decrypted the vault key and is now authorized.");
      await refresh(activeUser, activeClient);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      consumingPairingRef.current = null;
    }
  }, [refresh]);

  useEffect(() => {
    if (!client || !user || !pendingPairing) {
      return;
    }
    return subscribeRemotePairing(
      client,
      user.uid,
      pendingPairing.pairingId,
      (pairing) => {
        if (pairing?.status === "approved") {
          void consumeApprovedPairing(client, user, pendingPairing, pairing);
        }
      },
      (caught) => setError(errorMessage(caught))
    );
  }, [client, consumeApprovedPairing, pendingPairing, user]);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateVault(): Promise<void> {
    if (!client || !user || remoteRoot !== null) {
      return;
    }
    await run("Creating encrypted vault", async () => {
      const local = await createAndSaveLocalVault({
        uid: user.uid,
        vaultId: randomId("vault"),
        epoch: 1,
        vaultKey: randomBytes(32),
        deviceName
      });
      try {
        await createRemoteVault(client, local);
      } catch (caught) {
        await deleteLocalVault(user.uid);
        throw caught;
      }
      setNotice("Vault created. Firebase received metadata and ciphertext keys only.");
      await refresh(user, client);
    });
  }

  async function handleStartPairing(): Promise<void> {
    if (!client || !user || !remoteRoot || localVault !== null) {
      return;
    }
    await run("Creating one-time pairing", async () => {
      const keys = await generateDeviceKeyPair();
      const pairingId = randomId("pair");
      const deviceId = randomId("device");
      const safetyCode = await createSafetyCode({
        pairingId,
        deviceId,
        publicKeyJwk: keys.publicKeyJwk
      });
      const pending: PendingPairingState = {
        schemaVersion: VAULT_SCHEMA_VERSION,
        uid: user.uid,
        pairingId,
        vaultId: remoteRoot.activeVaultId,
        epoch: remoteRoot.epoch,
        deviceId,
        deviceName,
        devicePrivateKey: keys.privateKey,
        devicePublicKeyJwk: keys.publicKeyJwk,
        safetyCode,
        createdAt: Date.now()
      };
      await savePendingPairing(pending);
      await createRemotePairing({
        client,
        uid: user.uid,
        pairingId,
        vaultId: pending.vaultId,
        epoch: pending.epoch,
        deviceId,
        deviceName,
        publicKeyJwk: keys.publicKeyJwk,
        safetyCode,
        expiresAt: new Date(Date.now() + 5 * 60_000)
      });
      const qrPayload: PairingQrPayload = {
        kind: "boxie-device-pairing",
        version: 1,
        pairingId,
        projectId: client.projectId
      };
      const encoded = encodePairingPayload(qrPayload);
      const link = new URL(window.location.href);
      link.searchParams.set("vaultSpike", "1");
      link.searchParams.set("pairing", encoded);
      const linkValue = link.toString();
      setPendingPairing(pending);
      setPairingLink(linkValue);
      setPairingQrUrl(await QRCode.toDataURL(linkValue, {
        width: 280,
        margin: 2,
        color: { dark: "#17151f", light: "#fffaf3" },
        errorCorrectionLevel: "M"
      }));
    });
  }

  async function loadApproval(value: string): Promise<void> {
    if (!client || !user || !localVault) {
      throw new Error("This browser must already hold an authorized Boxie vault.");
    }
    const payload = decodePairingPayload(value.trim());
    if (payload.projectId !== client.projectId) {
      throw new Error("This pairing request belongs to a different Firebase project.");
    }
    const pairing = await getRemotePairing(client, user.uid, payload.pairingId);
    if (!pairing) {
      throw new Error("The pairing request was not found or has expired.");
    }
    const expiry = expiresAtMillis(pairing.expiresAt);
    if (!expiry || expiry <= Date.now()) {
      throw new Error("The pairing request has expired. Create a new QR code.");
    }
    const expectedCode = await createSafetyCode({
      pairingId: payload.pairingId,
      deviceId: pairing.requestingDeviceId,
      publicKeyJwk: pairing.requestingPublicKeyJwk
    });
    if (expectedCode !== pairing.safetyCode) {
      throw new Error("The pairing safety code does not match the device key.");
    }
    if (pairing.vaultId !== localVault.vaultId || pairing.epoch !== localVault.epoch) {
      throw new Error("The pairing request targets another vault epoch.");
    }
    setApprovalPairingId(payload.pairingId);
    setApprovalPairing(pairing);
    setPairingInput(value);
    setScannerOpen(false);
  }

  async function handleApprovePairing(): Promise<void> {
    if (!client || !user || !localVault || !approvalPairing || !approvalPairingId) {
      return;
    }
    await run("Encrypting key for new device", async () => {
      const vaultKey = await readLocalVaultKey(localVault);
      const envelope = await wrapVaultKeyForPairing({
        vaultKey,
        recipientPublicKeyJwk: approvalPairing.requestingPublicKeyJwk,
        uid: user.uid,
        pairingId: approvalPairingId,
        vaultId: approvalPairing.vaultId,
        epoch: approvalPairing.epoch,
        deviceId: approvalPairing.requestingDeviceId
      });
      await approveRemotePairing({
        client,
        uid: user.uid,
        pairingId: approvalPairingId,
        approvingDeviceId: localVault.deviceId,
        ...envelope
      });
      setNotice(`Approved ${approvalPairing.requestingDeviceName}. The vault key was encrypted before upload.`);
      setApprovalPairing(null);
      setApprovalPairingId(null);
      setPairingInput("");
      const location = new URL(window.location.href);
      location.searchParams.delete("pairing");
      window.history.replaceState({}, "", location);
    });
  }

  async function handleCreateSyntheticObject(): Promise<void> {
    if (!client || !user || !localVault || !remoteRoot) {
      return;
    }
    await run("Encrypting synthetic object", async () => {
      const objectId = randomId("synthetic");
      const payload: SyntheticPayload = {
        kind: "boxie-synthetic-vault-spike",
        message: `Synthetic Boxie payload ${crypto.randomUUID()} — no mailbox data.`,
        createdAt: new Date().toISOString()
      };
      const vaultKey = await readLocalVaultKey(localVault);
      const encrypted = await encryptSyntheticObject({
        vaultKey,
        vaultId: localVault.vaultId,
        objectId,
        epoch: localVault.epoch,
        payload
      });
      await saveEncryptedObject({
        client,
        uid: user.uid,
        vaultId: localVault.vaultId,
        objectId,
        encrypted
      });
      const serialized = JSON.stringify(encrypted);
      setCloudInspection({
        objectId,
        encrypted,
        plaintextAbsent: !serialized.includes(payload.message) && !serialized.includes(payload.kind)
      });
      setDecrypted((current) => ({ ...current, [objectId]: payload }));
      setObjects(await listEncryptedObjects({ client, uid: user.uid, vaultId: localVault.vaultId }));
      setNotice("Synthetic payload encrypted locally and uploaded.");
    });
  }

  async function handleDecryptObject(row: CloudObjectRow): Promise<void> {
    if (!localVault) {
      return;
    }
    await run("Decrypting locally", async () => {
      const vaultKey = await readLocalVaultKey(localVault);
      if (row.encrypted.contentType === CONVERSATION_SNAPSHOT_CONTENT_TYPE) {
        const snapshot = await decryptConversationSnapshot({
          vaultKey,
          localVault,
          objectId: row.id,
          encrypted: row.encrypted
        });
        const counts = snapshotCounts(snapshot);
        setConversationSnapshotProof({
          objectId: row.id,
          exportedAt: snapshot.exportedAt,
          counts
        });
        setCloudInspection({
          objectId: row.id,
          encrypted: row.encrypted,
          plaintextAbsent: ciphertextExcludesConversationPlaintext(
            row.encrypted,
            snapshot
          )
        });
        return;
      }
      if (row.encrypted.contentType !== SYNTHETIC_CONTENT_TYPE) {
        throw new Error(`Unsupported encrypted object type ${row.encrypted.contentType}`);
      }
      const payload = await decryptSyntheticObject({
        vaultKey,
        vaultId: localVault.vaultId,
        objectId: row.id,
        encrypted: row.encrypted
      });
      setDecrypted((current) => ({ ...current, [row.id]: payload }));
      setCloudInspection({
        objectId: row.id,
        encrypted: row.encrypted,
        plaintextAbsent: !JSON.stringify(row.encrypted).includes(payload.message) &&
          !JSON.stringify(row.encrypted).includes(payload.kind)
      });
    });
  }

  async function handlePrepareConversationSnapshot(): Promise<void> {
    await run("Preparing local conversation snapshot", async () => {
      const prepared = await fetchConversationSnapshot();
      setPreparedConversationSnapshot(prepared);
      setNotice(
        `Prepared ${prepared.counts.conversations} conversations and `
        + `${prepared.counts.messages} messages locally. Nothing was uploaded.`
      );
    });
  }

  async function handleEncryptAndSyncConversationSnapshot(): Promise<void> {
    if (!client || !user || !localVault || !preparedConversationSnapshot) {
      return;
    }
    await run("Encrypting and syncing conversation snapshot", async () => {
      const vaultKey = await readLocalVaultKey(localVault);
      const prepared = await encryptConversationSnapshot({
        prepared: preparedConversationSnapshot,
        localVault,
        vaultKey
      });
      const localRepository = new IndexedDbEncryptedObjectRepository(
        user.uid,
        localVault.vaultId
      );
      const cloudRepository = new FirebaseEncryptedObjectRepository(
        client,
        user.uid,
        localVault.vaultId
      );
      const record = {
        objectId: prepared.objectId,
        encrypted: prepared.encrypted
      };
      await localRepository.put(record);
      await cloudRepository.put(record);

      const uploaded = await cloudRepository.get(prepared.objectId);
      if (!uploaded) {
        throw new Error("Firebase did not return the uploaded encrypted snapshot.");
      }
      const roundTrip = await decryptConversationSnapshot({
        vaultKey,
        localVault,
        objectId: uploaded.objectId,
        encrypted: uploaded.encrypted
      });
      setConversationSnapshotProof({
        objectId: prepared.objectId,
        exportedAt: roundTrip.exportedAt,
        counts: prepared.counts
      });
      setCloudInspection({
        objectId: prepared.objectId,
        encrypted: uploaded.encrypted,
        plaintextAbsent: ciphertextExcludesConversationPlaintext(
          uploaded.encrypted,
          roundTrip
        )
      });
      setObjects((await cloudRepository.list()).map((item) => ({
        id: item.objectId,
        encrypted: item.encrypted
      })));
      setNotice(
        `Encrypted snapshot synced and decrypted back locally: `
        + `${prepared.counts.conversations} conversations, ${prepared.counts.messages} messages.`
      );
    });
  }

  async function handleReset(): Promise<void> {
    if (!client || !user || !remoteRoot || resetPhrase !== RESET_PHRASE) {
      return;
    }
    if (!window.confirm("Erase Boxie’s encrypted cache and revoke every other device? Outlook itself is unchanged and Boxie can resync it.")) {
      return;
    }
    await run("Resetting encrypted vault", async () => {
      const previousLocal = localVault;
      const previousVaultId = remoteRoot.activeVaultId;
      const replacement = await createAndSaveLocalVault({
        uid: user.uid,
        vaultId: randomId("vault"),
        epoch: remoteRoot.epoch + 1,
        vaultKey: randomBytes(32),
        deviceName
      });
      let remoteCleanupComplete: boolean;
      try {
        ({ cleanupComplete: remoteCleanupComplete } = await resetRemoteVault({
          client,
          previousRoot: remoteRoot,
          replacement
        }));
      } catch (caught) {
        if (previousLocal) {
          await saveLocalVaultState(previousLocal);
        } else {
          await deleteLocalVault(user.uid);
        }
        throw caught;
      }
      let localCleanupComplete = true;
      try {
        await Promise.all([
          deleteIndexedDbCanonicalVault(user.uid, previousVaultId),
          deleteIndexedDbEncryptedObjectVault(user.uid, previousVaultId),
          deleteLocalPairings(user.uid)
        ]);
      } catch {
        localCleanupComplete = false;
      }
      setPendingPairing(null);
      setResetPhrase("");
      setDecrypted({});
      setCloudInspection(null);
      setPreparedConversationSnapshot(null);
      setConversationSnapshotProof(null);
      setNotice(
        remoteCleanupComplete && localCleanupComplete
          ? `Vault recovery complete. Epoch ${replacement.epoch} rejects stale device writes.`
          : `Vault recovery completed and this device kept the epoch ${replacement.epoch} key. Some revoked cache could not be removed yet.`
      );
      await refresh(user, client);
      if (recoveryRequested && remoteCleanupComplete && localCleanupComplete) {
        window.location.replace("/?cloudVault=1&recovered=1");
      }
    });
  }

  async function handleForgetStaleLocalKey(): Promise<void> {
    if (!client || !user || !localVault || !remoteRoot) {
      return;
    }
    if (!window.confirm(
      "Discard this revoked device key and return to pairing? Boxie data encrypted only with this old key will become unreadable on this device."
    )) {
      return;
    }
    await run("Forgetting revoked local key", async () => {
      await deleteLocalVault(user.uid);
      await refresh(user, client);
    });
  }

  const authorized = Boolean(
    remoteRoot &&
    localVault &&
    remoteRoot.epoch === localVault.epoch &&
    remoteRoot.activeVaultId === localVault.vaultId
  );
  const stale = Boolean(remoteRoot && localVault && !authorized);
  const statusBanner = (error || notice || busy) && <div className={`spike-banner ${error ? "is-error" : notice ? "is-success" : ""}`}>
    {busy && <LoaderCircle className="spin" />}
    {notice && !busy && <Check />}
    {error && <X />}
    <span>{error ?? notice ?? busy}</span>
    {(error || notice) && <button aria-label="Dismiss" onClick={() => { setError(null); setNotice(null); }}><X /></button>}
  </div>;

  if (!client) {
    return <SpikeFrame>
      <section className="spike-card spike-config">
        <LockKeyhole />
        <h2>Firebase configuration needed</h2>
        <p>Copy the dedicated Boxie web-app values into <code>.env.local</code>, then reopen this spike.</p>
        <pre>VITE_FIREBASE_API_KEY={"<public web key>"}{"\n"}VITE_FIREBASE_AUTH_DOMAIN=dionlabs-fe92e.firebaseapp.com{"\n"}VITE_FIREBASE_PROJECT_ID=dionlabs-fe92e{"\n"}VITE_FIREBASE_APP_ID={"<Boxie app id>"}</pre>
      </section>
    </SpikeFrame>;
  }

  if (user === undefined) {
    return <SpikeFrame><CenteredLoading label="Restoring Firebase session" /></SpikeFrame>;
  }

  if (!user) {
    return <SpikeFrame>
      {statusBanner}
      <section className="spike-card spike-signin">
        <img src="/brand/boxie-avatar.png" alt="Boxie" />
        <span className="spike-kicker">Synthetic vault experiment</span>
        <h2>Sign in to isolate your test vault</h2>
        <p>Google identifies the owner. It never receives or derives the device-held vault key.</p>
        <button className="spike-primary" onClick={() => void run("Signing in", async () => {
          await signInWithGoogle(client);
        })} disabled={busy !== null}>
          <LogIn /> Sign in with Google
        </button>
        {import.meta.env.VITE_BOXIE_SPIKE_ALLOW_EMULATOR_IDENTITY === "true" && <button className="spike-guest" onClick={() => void run("Opening local synthetic identity", async () => {
          await signInWithEmulatorIdentity(client);
        })} disabled={busy !== null}>
          <ShieldCheck /> Use the local emulator test identity
        </button>}
      </section>
    </SpikeFrame>;
  }

  if (remoteRoot === undefined || localVault === undefined) {
    return <SpikeFrame><CenteredLoading label="Inspecting local and encrypted cloud state" /></SpikeFrame>;
  }

  return <SpikeFrame>
    <header className="spike-session">
      <div>
        <span className="spike-status-dot" />
        <span>{user.email ?? user.uid}</span>
        <small>{client.projectId}</small>
      </div>
      <button onClick={() => void signOutUser(client)}><LogOut /> Sign out</button>
    </header>

    {statusBanner}

    {remoteRoot === null && <section className="spike-card spike-create">
      <div className="spike-icon"><KeyRound /></div>
      <span className="spike-kicker">First authorized device</span>
      <h2>Create an encrypted Boxie vault</h2>
      <p>This generates a random 256-bit vault key and a non-exportable device key locally. Firebase receives identifiers, public keys, and encrypted objects only.</p>
      <label>Device name<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} /></label>
      <button className="spike-primary" onClick={() => void handleCreateVault()} disabled={busy !== null || deviceName.trim().length === 0}>
        <LockKeyhole /> Create device-held vault
      </button>
    </section>}

    {remoteRoot && localVault === null && !recoveryRequested && <section className="spike-card spike-pair-request">
      <div className="spike-icon"><Smartphone /></div>
      <span className="spike-kicker">New device</span>
      <h2>Ask an authorized device for the key</h2>
      <p>Your Firebase account can see the encrypted vault, but this browser cannot decrypt it until another device approves the one-time exchange. Pairing never resets the vault or revokes an existing device.</p>
      <label>Device name<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} /></label>
      {!pendingPairing && <button className="spike-primary" onClick={() => void handleStartPairing()} disabled={busy !== null || deviceName.trim().length === 0}>
        <QrCode /> Create five-minute QR request
      </button>}
      {pendingPairing && <div className="spike-qr-request">
        {pairingQrUrl && <img src={pairingQrUrl} alt="One-time Boxie device pairing QR code" />}
        <div>
          <small>Compare on both devices</small>
          <strong>{pendingPairing.safetyCode}</strong>
          <p>Waiting for an authorized device. The QR contains a pairing reference, never the vault key.</p>
          {pairingLink && <button onClick={() => void navigator.clipboard.writeText(pairingLink).then(() => setNotice("Pairing link copied."))}><Copy /> Copy pairing link</button>}
        </div>
      </div>}
      <div className="spike-recovery-entry">
        <div>
          <strong>Emergency cleanup</strong>
          <span>Signed in but unable to pair? Erase Boxie’s encrypted cache and make this browser the new trusted device.</span>
        </div>
        <a href="/?vaultSpike=1&recovery=1">Start over</a>
      </div>
    </section>}

    {remoteRoot && localVault === null && recoveryRequested && <section className="spike-card spike-recovery-choice">
      <div className="spike-icon spike-icon-danger"><AlertTriangle /></div>
      <span className="spike-kicker">Emergency cleanup</span>
      <h2>Start this Boxie account over here</h2>
      <p>You are signed in as <strong>{user.email ?? user.uid}</strong>, so you can erase this account’s encrypted Boxie cache without an old device. Boxie will revoke every existing device, create a fresh key in this browser, and return you to setup. Outlook itself is not changed.</p>
      <p>Ordinary device setup never does this. Continue only when no authorized device remains or the encrypted cache is disposable.</p>
      <a className="spike-recovery-cancel" href="/?vaultSpike=1"><ArrowLeft /> Back to pairing</a>
      <label>Type <code>{RESET_PHRASE}</code><input value={resetPhrase} onChange={(event) => setResetPhrase(event.target.value)} /></label>
      <button onClick={() => void handleReset()} disabled={resetPhrase !== RESET_PHRASE || busy !== null}><Trash2 /> Erase Boxie state and continue setup</button>
    </section>}

    {stale && localVault && remoteRoot && <section className="spike-card spike-warning">
      <div className="spike-icon spike-icon-warning"><AlertTriangle /></div>
      <span className="spike-kicker">Device revoked by recovery</span>
      <h2>This device holds an old vault epoch</h2>
      <p>Local epoch {localVault.epoch}; current epoch {remoteRoot.epoch}. Another device completed last-resort recovery, which revoked this key. Normal device pairing never causes this state.</p>
      <button onClick={() => void handleForgetStaleLocalKey()}><Trash2 /> Discard old local key and pair again</button>
    </section>}

    {authorized && localVault && remoteRoot && <>
      <section className="spike-grid">
        <article className="spike-card spike-vault-summary">
          <span className="spike-kicker">Authorized device</span>
          <h2><ShieldCheck /> Vault unlocked locally</h2>
          <dl>
            <div><dt>Vault</dt><dd>{localVault.vaultId.slice(0, 20)}…</dd></div>
            <div><dt>Epoch</dt><dd>{localVault.epoch}</dd></div>
            <div><dt>Device</dt><dd>{localVault.deviceName}</dd></div>
          </dl>
          <button className="spike-primary" onClick={() => void handleCreateSyntheticObject()} disabled={busy !== null}>
            <LockKeyhole /> Encrypt synthetic object
          </button>
        </article>

        <article className="spike-card spike-approve">
          <span className="spike-kicker">Authorize another device</span>
          <h2><QrCode /> Scan or paste its request</h2>
          <p>The safety code must match what the new device displays.</p>
          <div className="spike-inline-input">
            <input value={pairingInput} onChange={(event) => setPairingInput(event.target.value)} placeholder="Paste pairing link" />
            <button onClick={() => void run("Loading pairing", () => loadApproval(pairingInput))} disabled={!pairingInput.trim()}><RefreshCw /> Load</button>
          </div>
          <button onClick={() => setScannerOpen((current) => !current)}><ScanLine /> {scannerOpen ? "Close camera" : "Scan QR"}</button>
          {scannerOpen && <QrScanner onDetected={(value) => void run("Reading QR", () => loadApproval(value))} onError={setError} />}
          {approvalPairing && <div className="spike-approval-card">
            <small>New device</small>
            <b>{approvalPairing.requestingDeviceName}</b>
            <strong>{approvalPairing.safetyCode}</strong>
            <button className="spike-primary" onClick={() => void handleApprovePairing()} disabled={busy !== null}><KeyRound /> Codes match — approve</button>
          </div>}
        </article>
      </section>

      <section className="spike-card spike-objects">
        <header><div><span className="spike-kicker">Portable projection boundary</span><h2>Encrypt Boxie's current chats</h2></div></header>
        <p>First prepare a local snapshot for review. Upload happens only when you press the second button; Firebase receives ciphertext, while canonical MIME and Outlook sync state stay in SQLite.</p>
        <div className="spike-snapshot-actions">
          <button onClick={() => void handlePrepareConversationSnapshot()} disabled={busy !== null}>
            <RefreshCw /> Prepare local snapshot
          </button>
          <button className="spike-primary" onClick={() => void handleEncryptAndSyncConversationSnapshot()} disabled={busy !== null || !preparedConversationSnapshot}>
            <LockKeyhole /> Encrypt and sync snapshot
          </button>
        </div>
        {preparedConversationSnapshot && <dl className="spike-snapshot-summary">
          <div><dt>Conversations</dt><dd>{preparedConversationSnapshot.counts.conversations}</dd></div>
          <div><dt>Messages</dt><dd>{preparedConversationSnapshot.counts.messages}</dd></div>
          <div><dt>Plaintext size</dt><dd>{preparedConversationSnapshot.counts.utf8Bytes.toLocaleString()} bytes</dd></div>
          <div><dt>Cloud state</dt><dd>{conversationSnapshotProof ? "Ciphertext verified" : "Not uploaded"}</dd></div>
        </dl>}
        {conversationSnapshotProof && <p className="spike-proof-line"><ShieldCheck /> Decrypted the uploaded snapshot locally from <code>{conversationSnapshotProof.objectId}</code>.</p>}
      </section>

      <section className="spike-card spike-objects">
        <header><div><span className="spike-kicker">Ciphertext inventory</span><h2>Encrypted vault objects</h2></div><b>{objects.length}</b></header>
        {objects.length === 0 ? <p className="spike-empty">Create a synthetic object or sync a prepared conversation snapshot.</p> : <div className="spike-object-list">
          {objects.map((row) => {
            const payload = decrypted[row.id];
            const isConversationSnapshot = row.encrypted.contentType === CONVERSATION_SNAPSHOT_CONTENT_TYPE;
            return <article key={row.id}>
              <div><code>{row.id}</code><small>{isConversationSnapshot ? "Conversation snapshot" : "Synthetic test"} · {row.encrypted.algorithm} · epoch {row.encrypted.epoch}</small></div>
              <button onClick={() => void handleDecryptObject(row)}><LockKeyhole /> Decrypt locally</button>
              {payload && <p>{payload.message}</p>}
              {isConversationSnapshot && conversationSnapshotProof?.objectId === row.id && <p>{conversationSnapshotProof.counts.conversations} conversations · {conversationSnapshotProof.counts.messages} messages · exported {new Date(conversationSnapshotProof.exportedAt).toLocaleString()}</p>}
            </article>;
          })}
        </div>}
        {cloudInspection && <details className="spike-cloud-proof" open>
          <summary><ShieldCheck /> Cloud inspection: {cloudInspection.plaintextAbsent ? "plaintext absent" : "unexpected plaintext found"}</summary>
          <pre>{JSON.stringify(cloudInspection.encrypted, null, 2)}</pre>
        </details>}
      </section>

      <section className="spike-card spike-reset">
        <span className="spike-kicker">Destructive encrypted-cache recovery</span>
        <h2>Reset vault and revoke other devices</h2>
        <p>This advances the epoch, creates a new device-held key, and deletes encrypted cloud objects. Old devices can no longer write; canonical Outlook mail remains in the local source store.</p>
        <label>Type <code>{RESET_PHRASE}</code><input value={resetPhrase} onChange={(event) => setResetPhrase(event.target.value)} /></label>
        <button onClick={() => void handleReset()} disabled={resetPhrase !== RESET_PHRASE || busy !== null}><Trash2 /> Reset synthetic vault</button>
      </section>
    </>}
  </SpikeFrame>;
}

function SpikeFrame({ children }: { children: React.ReactNode }) {
  return <main className="vault-spike-shell">
    <header className="spike-hero">
      <a href="/" aria-label="Return to Boxie"><img src="/brand/boxie-avatar.png" alt="" /></a>
      <div><span>Boxie labs</span><h1>Encrypted device-pairing spike</h1><p>Device-held keys · explicit encrypted sync · no AI provider</p></div>
      <a className="spike-back" href="/?cloudVault=1"><ArrowLeft /> Back to setup</a>
    </header>
    <div className="spike-content">{children}</div>
  </main>;
}

function CenteredLoading({ label }: { label: string }) {
  return <div className="spike-loading"><LoaderCircle className="spin" /><span>{label}</span></div>;
}

function QrScanner({
  onDetected,
  onError
}: {
  onDetected: (value: string) => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let controls: IScannerControls | null = null;
    let stopped = false;
    if (!videoRef.current) {
      return;
    }
    void reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
      if (!result || stopped) {
        return;
      }
      stopped = true;
      controls?.stop();
      onDetected(result.getText());
    }).then((nextControls) => {
      controls = nextControls;
    }).catch((caught: unknown) => onError(errorMessage(caught)));
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onDetected, onError]);
  return <div className="spike-scanner"><video ref={videoRef} muted playsInline /><span>Point this camera at the new device’s Boxie QR.</span></div>;
}
