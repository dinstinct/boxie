import {reportFailure} from '../support/reporting';
import {recoverRepresentedLegacyQueue} from "./legacy-queue-recovery";
import {SyncedOutlook} from "./sync-v2-outlook";
import { OrganizationActions, EncryptedOrganizationJournal } from "./organization-actions";
import { SyncedOrganization } from "./sync-v2-organization";
import { SyncV2Store } from "./sync-v2-store";
import { LoaderCircle, LockKeyhole, Mail } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { App } from "../App";
import { subscribeToUser } from "../vault-spike/firebase-client";
import { readLocalVaultKey } from "../vault-spike/local-store";
import { onboardingFirebaseClient, ensureFirstDeviceVault } from "../onboarding/vault-setup";
import { BrowserCanonicalMailStore } from "./browser-canonical-mail-store";
import { BrowserMailboxClient } from "./browser-mailbox-client";
import { CanonicalCloudReplicator } from "./canonical-cloud-replication";
import { hydrateMissingCanonicalReplica } from "./canonical-replica-hydration";
import { IndexedDbEncryptedCanonicalRepository } from "./encrypted-canonical-repository";
import {
  ChunkedCanonicalCloudRepository,
  FirebaseCanonicalReplicaDocumentStore
} from "./firestore-canonical-replica";
import "../onboarding/onboarding.css";

type RuntimeState =
  | { kind: "loading"; label: string }
  | { kind: "ready"; client: BrowserMailboxClient }
  | { kind: "setup"; message: string }
  | { kind: "error"; message: string };

export function CloudMailboxApp() {
  const firebase = useMemo(() => onboardingFirebaseClient(), []);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [runtime, setRuntime] = useState<RuntimeState>({
    kind: "loading",
    label: "Unlocking your encrypted inbox"
  });

  useEffect(() => {
    if (!firebase) {
      setUser(null);
      setRuntime({ kind: "setup", message: "Boxie’s Firebase web configuration is missing." });
      return;
    }
    return subscribeToUser(firebase, setUser);
  }, [firebase]);

  useEffect(() => {
    if (!firebase || user === undefined) return;
    if (!user) {
      setRuntime({ kind: "setup", message: "Finish private setup before opening your inbox." });
      return;
    }
    let active = true;
    setRuntime({ kind: "loading", label: "Unlocking your encrypted inbox" });
    void (async () => {
      const vault = await ensureFirstDeviceVault({ client: firebase, user });
      if (vault.kind !== "ready") {
        throw new Error("This browser needs vault pairing or recovery before it can read mail.");
      }
      const vaultKey = await readLocalVaultKey(vault.local);
      const localRepository = new IndexedDbEncryptedCanonicalRepository(
        vault.local.uid,
        vault.local.vaultId
      );
      const syncStore = new SyncV2Store(firebase.db, vault.local.uid, vault.local.vaultId, vault.local.epoch);
      const rollout = await syncStore.rollout();
      if (rollout?.phase === "frozen" || rollout?.phase === "preparing") throw new Error("Your mailbox is being upgraded. Please reopen Boxie after migration completes.");
      const v2 = rollout?.phase === "active";
      const cloudRepository = new ChunkedCanonicalCloudRepository(
        new FirebaseCanonicalReplicaDocumentStore(
          firebase,
          vault.local.uid,
          vault.local.vaultId
        ),
        v2 ? {key: `${firebase.projectId}/boxie/${vault.local.uid}/vaults/${vault.local.vaultId}/${vault.local.epoch}/baseline`, epoch: vault.local.epoch} : undefined
      );
      await hydrateMissingCanonicalReplica({
        local: localRepository,
        cloud: cloudRepository
      });
      const store = BrowserCanonicalMailStore.create({
        localVault: vault.local,
        vaultKey,
        repository: localRepository
      });
      const mailboxes = await store.listMailboxes();
      const mailbox = mailboxes[0];
      if (!mailbox) {
        if (active) {
          setRuntime({ kind: "setup", message: "Connect an Outlook mailbox to create its encrypted local index." });
        }
        return;
      }
      const syncVault = {vaultId: vault.local.vaultId, epoch: vault.local.epoch, vaultKey, deviceId: vault.local.deviceId};
      if (v2 && await localRepository.pendingCount() > 0) {
        const result = await recoverRepresentedLegacyQueue({queue: localRepository, cloud: cloudRepository,
          vault: {...syncVault, uid: vault.local.uid}});
        if (result.remaining) throw new Error(`${result.remaining} older browser changes need review before sync can resume. They remain encrypted on this browser; ${result.recovered} already-synced entries were backed up and reconciled.`);
      }
      const cloudReplicator = new CanonicalCloudReplicator(localRepository, cloudRepository);
      const client = await BrowserMailboxClient.create({
        store,
        mailbox,
        vaultKey,
        cloudReplicator,
        ...(v2 ? {sourceSync: new SyncedOutlook(syncStore, syncVault)} : {}),
        ...(v2 || import.meta.env.VITE_BOXIE_ORGANIZATION_SYNC_V2 === "true" ? {organizationActions: new OrganizationActions(
          new SyncedOrganization(syncStore,
            {vaultId: vault.local.vaultId, epoch: vault.local.epoch, vaultKey, deviceId: vault.local.deviceId}),
          new EncryptedOrganizationJournal({uid: vault.local.uid, vaultId: vault.local.vaultId, epoch: vault.local.epoch, vaultKey})
        )} : {})
      });
      if (active) setRuntime({ kind: "ready", client });
    })().catch((caught) => {
      if (active) {
        reportFailure('startup');
        setRuntime({
          kind: "error",
          message: caught instanceof Error ? caught.message : "The encrypted inbox could not be opened."
        });
      }
    });
    return () => {
      active = false;
    };
  }, [firebase, user]);

  if (runtime.kind === "ready") {
    return <App mailboxClient={runtime.client} />;
  }

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <a href="/" aria-label="Return to Boxie"><img src="/brand/boxie-icon.webp" alt="" /><strong>Boxie</strong></a>
        <a href="/feedback">Feedback / report a problem</a>
      </header>
      <section className="onboarding-card">
        {runtime.kind === "loading" ? (
          <div className="onboarding-loading">
            <LoaderCircle className="spin" />
            <strong>{runtime.label}</strong>
            <small>Decryption stays on this device.</small>
          </div>
        ) : (
          <>
            <div className="onboarding-icon">{runtime.kind === "error" ? <LockKeyhole /> : <Mail />}</div>
            <span className="onboarding-kicker">Setup needed</span>
            <h1>Your encrypted mailbox is not ready here yet.</h1>
            <p>{runtime.message}</p>
            <a className="onboarding-primary" href="/?cloudVault=1">Open private setup</a>
          </>
        )}
      </section>
    </main>
  );
}

export {LocalMailboxApp as BrowserMailboxApp} from "../onboarding/LocalMailboxApp";
