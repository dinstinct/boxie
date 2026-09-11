import {reportFailure} from '../support/reporting';
import {initializeFirstMailbox} from "./initialize-sync";
import {SyncV2Store} from "../mail/sync-v2-store";
import {SyncedOutlook, mergeSourceMemberships} from "../mail/sync-v2-outlook";
import {hydrateMissingCanonicalReplica} from "../mail/canonical-replica-hydration";
import {recoverRepresentedLegacyQueue} from "../mail/legacy-queue-recovery";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  Mail,
  Database,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  UserRoundCheck
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signOutUser,
  subscribeToUser
} from "../vault-spike/firebase-client";
import {
  chooseOutlookAccount,
  consumeOutlookRedirectAccount,
  forgetSelectedOutlookAccount,
  getOutlookAccessToken,
  hasPendingOutlookRedirect,
  microsoftBrowserClientId,
  type SelectedOutlookAccount
} from "./microsoft-browser";
import { BrowserCanonicalMailStore } from "../mail/browser-canonical-mail-store";
import { CanonicalCloudReplicator } from "../mail/canonical-cloud-replication";
import { BrowserOutlookGraphClient } from "../mail/browser-outlook-graph-client";
import {
  type BrowserOutlookSyncResult
} from "../mail/browser-outlook-synchronizer";
import { IndexedDbEncryptedCanonicalRepository } from "../mail/encrypted-canonical-repository";
import {
  ChunkedCanonicalCloudRepository,
  FirebaseCanonicalReplicaDocumentStore
} from "../mail/firestore-canonical-replica";
import { readLocalVaultKey } from "../vault-spike/local-store";
import {
  ensureFirstDeviceVault,
  onboardingFirebaseClient,
  type FirstDeviceVaultResult
} from "./vault-setup";
import "./onboarding.css";

type LoadingValue<T> = T | null | undefined;

interface InitialSyncSummary {
  activatedAt: string;
  activeMessageCount: number;
  results: BrowserOutlookSyncResult[];
}

function safeError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "auth/unauthorized-domain"
  ) {
    return "Firebase does not authorize this hostname. Use http://localhost:5174 for local setup.";
  }
  if (
    error &&
    typeof error === "object" &&
    "errorCode" in error &&
    String((error as { errorCode?: unknown }).errorCode) === "user_cancelled"
  ) {
    return "Microsoft account selection was cancelled. Nothing was connected.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function OnboardingApp() {
  const firebase = useMemo(() => onboardingFirebaseClient(), []);
  const [started, setStarted] = useState(() => hasPendingOutlookRedirect());
  const [user, setUser] = useState<LoadingValue<User>>(undefined);
  const [vault, setVault] = useState<LoadingValue<FirstDeviceVaultResult>>(undefined);
  const [outlook, setOutlook] = useState<SelectedOutlookAccount | null>(null);
  const [initialSync, setInitialSync] = useState<InitialSyncSummary | null>(null);
  const [vaultRetry, setVaultRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vaultSetupRef = useRef<Promise<FirstDeviceVaultResult> | null>(null);
  const accountUidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!firebase) {
      setUser(null);
      return;
    }
    return subscribeToUser(firebase, (nextUser) => {
      if (accountUidRef.current !== (nextUser?.uid ?? null)) {
        accountUidRef.current = nextUser?.uid ?? null;
        setVault(undefined);
        setOutlook(null);
        setInitialSync(null);
        setError(null);
        vaultSetupRef.current = null;
      }
      setUser(nextUser);
    });
  }, [firebase]);

  useEffect(() => {
    if (!started || !firebase || !user) {
      return;
    }
    let active = true;
    const setup = vaultSetupRef.current ?? ensureFirstDeviceVault({ client: firebase, user });
    vaultSetupRef.current = setup;
    setBusy("Securing this device");
    setup
      .then((value) => { if (active) setVault(value); })
      .catch((caught) => {
        if (!active) return;
        setVault(null);
        setError(safeError(caught));
      })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, [started, firebase, user, vaultRetry]);

  useEffect(() => {
    if (vault?.kind !== "ready" || outlook || !hasPendingOutlookRedirect()) {
      return;
    }
    let active = true;
    setBusy("Finishing Microsoft account selection");
    void consumeOutlookRedirectAccount()
      .then((selected) => {
        if (active && selected) setOutlook(selected);
      })
      .catch((caught) => {
        if (active) setError(safeError(caught));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [vault, outlook]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (caught) {
      reportFailure('signin');
      setError(safeError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function activateAndSyncMailbox() {
    if (!readyVault || !outlook || !firebase || readyVault.local.uid !== accountUidRef.current) return;
    setError(null);
    try {
      setBusy("Preparing encrypted mail storage");
      const vaultKey = await readLocalVaultKey(readyVault.local);
      const localRepository = new IndexedDbEncryptedCanonicalRepository(
        readyVault.local.uid,
        readyVault.local.vaultId
      );
      const store = BrowserCanonicalMailStore.create({
        localVault: readyVault.local,
        vaultKey,
        repository: localRepository
      });
      if (outlook.tenantId !== "9188040d-6c67-4c5b-b112-36a304b66dad") {
        throw new Error("Boxie currently supports personal Outlook accounts. Work and school accounts stay separate and are not supported yet.");
      }
      const cloudRepository = new ChunkedCanonicalCloudRepository(
        new FirebaseCanonicalReplicaDocumentStore(firebase, readyVault.local.uid, readyVault.local.vaultId)
      );
      const sync = new SyncV2Store(firebase.db, readyVault.local.uid, readyVault.local.vaultId, readyVault.local.epoch);
      const verifyBaseline = async () => {
        const records = await cloudRepository.list();
        const identities = records.filter(record => record.kind === "mailbox");
        if (identities.length !== 1) throw new Error("Expected exactly one encrypted mailbox identity. Setup stopped without changing it.");
        await hydrateMissingCanonicalReplica({local: localRepository, cloud: cloudRepository});
        const mailboxes = await store.listMailboxes();
        if (mailboxes.length !== 1 || mailboxes[0]!.providerAccountId !== outlook.homeAccountId) {
          throw new Error("This vault belongs to a different Outlook account. Choose its original account; mailboxes are never merged.");
        }
      };
      await initializeFirstMailbox({sync, deviceId: readyVault.local.deviceId,
        prepareBaseline: async () => {
          await hydrateMissingCanonicalReplica({local: localRepository, cloud: cloudRepository});
          const existing = await store.listMailboxes();
          if (existing.length > 1 || existing.some(mailbox => mailbox.providerAccountId !== outlook.homeAccountId)) {
            throw new Error("Another Outlook account already belongs to this vault. Nothing was replaced.");
          }
          if ((await Promise.all(existing.map(mailbox => store.listMessages(mailbox)))).some(messages => messages.length > 0)) {
            throw new Error("Existing mail needs an explicit migration, not first-device setup.");
          }
          await store.activateOutlookAccount({providerAccountId: outlook.homeAccountId, emailAddress: outlook.username, activatedAt: new Date().toISOString()});
          const replication = await new CanonicalCloudReplicator(localRepository, cloudRepository).drain();
          if (replication.remaining !== 0) throw new Error("Encrypted identity backup did not finish. Retry setup.");
        }, verifyBaseline});
      const mailbox = (await store.listMailboxes())[0]!;
      const syncVault = {vaultId: readyVault.local.vaultId, epoch: readyVault.local.epoch, vaultKey, deviceId: readyVault.local.deviceId};
      if (await localRepository.pendingCount()) {
        const recovery = await recoverRepresentedLegacyQueue({queue: localRepository, cloud: cloudRepository, vault: {...syncVault, uid: readyVault.local.uid}});
        if (recovery.remaining) throw new Error("Older local changes remain preserved and need review before sync can continue.");
      }
      setBusy("Syncing new mail with your encrypted vault");
      const source = new SyncedOutlook(sync, syncVault);
      const baseline = await store.listMessages(mailbox);
      await source.sync(mailbox, baseline, new BrowserOutlookGraphClient(() => getOutlookAccessToken(outlook.homeAccountId)));
      const messages = mergeSourceMemberships(baseline, await source.memberships(mailbox, baseline));
      const results: BrowserOutlookSyncResult[] = [];
      if (readyVault.local.uid !== accountUidRef.current) return;
      setInitialSync({
        activatedAt: mailbox.activatedAt,
        activeMessageCount: messages.filter((message) => !message.providerRemovedAt).length,
        results
      });
    } catch (caught) {
      reportFailure('signin');
      setError(safeError(caught));
    } finally {
      setBusy(null);
    }
  }

  const readyVault = vault?.kind === "ready" ? vault : null;
  const currentStep = !started
    ? 0
    : !user
      ? 1
      : !readyVault
        ? 2
        : !outlook || !initialSync
          ? 3
          : 4;

  return (
    <main className="onboarding-shell">
      <a href="/feedback" style={{position:"fixed",right:20,bottom:16,zIndex:10}}>Feedback / report a problem</a>
      <header className="onboarding-header">
        <a href="/" aria-label="Return to Boxie"><img src="/brand/boxie-icon.png" alt="" /><strong>Boxie</strong></a>
        <a href="/app">Back to inbox</a>
      </header>

      <div className="onboarding-progress" aria-label={`Setup step ${currentStep + 1} of 5`}>
        {["Welcome", "Account", "Device", "Outlook", "Ready"].map((label, index) => (
          <div key={label} className={index < currentStep ? "is-complete" : index === currentStep ? "is-current" : ""}>
            <span>{index < currentStep ? <Check aria-hidden="true" /> : index + 1}</span>
            <small>{label}</small>
          </div>
        ))}
      </div>

      <section className="onboarding-card">
        {error && <div className="onboarding-error" role="alert">{error}</div>}

        {!started && <>
          <div className="onboarding-hero-art"><img src="/brand/boxie-avatar.png" alt="Boxie" /></div>
          <span className="onboarding-kicker">Optional cloud vault</span>
          <h1>Connect your devices.</h1>
          <p>This separate setup enables encrypted cloud storage and device pairing. Existing vault owners must use their original Google account. A local browser inbox is preserved separately; its messages and organization are not migrated by this setup.</p>
          <ul className="onboarding-promises">
            <li><Mail /><span><strong>Read-only Outlook</strong><small>Boxie cannot send, delete, or modify your mail.</small></span></li>
            <li><LockKeyhole /><span><strong>Device-held encryption</strong><small>Firebase never receives the key needed to read your inbox.</small></span></li>
            <li><ShieldCheck /><span><strong>You confirm the mailbox</strong><small>T0 is not established until the selected address looks right.</small></span></li>
          </ul>
          <button className="onboarding-primary" type="button" onClick={() => setStarted(true)}>Set up cloud vault <ArrowRight /></button>
        </>}

        {started && !firebase && <>
          <div className="onboarding-icon"><KeyRound /></div>
          <span className="onboarding-kicker">Configuration needed</span>
          <h1>Connect Boxie’s Firebase app first.</h1>
          <p>The onboarding flow needs the same public Firebase web configuration already used by the vault experiment.</p>
          <a className="onboarding-secondary" href="/?vaultSpike=1">Open vault diagnostics <ChevronRight /></a>
        </>}

        {started && firebase && user === undefined && <OnboardingLoading label="Restoring your Boxie account" />}

        {started && firebase && user === null && <>
          <div className="onboarding-icon"><UserRoundCheck /></div>
          <span className="onboarding-kicker">Your Boxie account</span>
          <h1>Choose who owns this encrypted vault.</h1>
          <p>Google identifies the owner of this optional cloud vault. It is not required for the local Outlook inbox. The consent screen currently uses dionlabs-fe92e.firebaseapp.com, Boxie’s Firebase authentication domain.</p>
          <button className="onboarding-primary" type="button" disabled={busy !== null} onClick={() => void run("Opening Google account chooser", async () => {
            await signInWithGoogle(firebase);
          })}><LogIn /> Choose Google account</button>
        </>}

        {started && firebase && user && vault === undefined && <OnboardingLoading label="Generating device encryption keys" />}

        {started && firebase && user && vault === null && <>
          <div className="onboarding-icon onboarding-icon-warning"><RefreshCw /></div>
          <span className="onboarding-kicker">Device setup stopped</span>
          <h1>Boxie did not change your vault.</h1>
          <p>The secure-device transaction failed and the newly generated local key was rolled back. You can retry without creating a duplicate vault.</p>
          <button className="onboarding-primary" type="button" disabled={busy !== null} onClick={() => {
            vaultSetupRef.current = null;
            setVault(undefined);
            setVaultRetry((current) => current + 1);
          }}><RefreshCw /> Try secure setup again</button>
        </>}

        {started && firebase && user && vault?.kind === "pairing_required" && <>
          <div className="onboarding-icon"><Smartphone /></div>
          <span className="onboarding-kicker">Existing encrypted vault</span>
          <h1>Approve this as a new device.</h1>
          <p>Your account already owns an encrypted Boxie vault, but this browser does not have its key. Pair it from an authorized device instead of creating another vault.</p>
          <a className="onboarding-primary" href="/?vaultSpike=1">Pair this device <ArrowRight /></a>
        </>}

        {started && firebase && user && vault?.kind === "stale_device" && <>
          <div className="onboarding-icon onboarding-icon-warning"><RefreshCw /></div>
          <span className="onboarding-kicker">Device state needs review</span>
          <h1>This browser’s key does not match the active vault.</h1>
          <p>Boxie stopped rather than replacing either key automatically. Use vault diagnostics to pair again or deliberately reset the encrypted cache.</p>
          <a className="onboarding-primary" href="/?vaultSpike=1">Review device vault <ArrowRight /></a>
        </>}

        {started && firebase && user && readyVault && !outlook && <>
          <div className="onboarding-check"><Check /></div>
          <span className="onboarding-kicker">Device secured</span>
          <h1>{readyVault.created ? "Your encrypted vault is ready." : "This device is already trusted."}</h1>
          <p>Next, choose the personal Outlook mailbox Boxie should observe. Microsoft’s chooser opens every time, even if another account is cached.</p>
          <div className="onboarding-account-proof"><LockKeyhole /><span><strong>{user.email ?? "Boxie account"}</strong><small>Vault owner · key stays on {readyVault.local.deviceName}</small></span></div>
          {microsoftBrowserClientId()
            ? <button className="onboarding-primary" type="button" disabled={busy !== null} onClick={() => void run("Opening Microsoft account chooser", async () => {
                setOutlook(await chooseOutlookAccount("/?cloudVault=1"));
              })}><Mail /> Choose Outlook account</button>
            : <div className="onboarding-config-note"><strong>Browser Microsoft login needs configuration</strong><code>VITE_BOXIE_MICROSOFT_CLIENT_ID=&lt;client id&gt;</code><small>Add the localhost SPA redirect URI in Microsoft Entra, then restart Vite.</small></div>}
        </>}

        {started && firebase && user && readyVault && outlook && !initialSync && <>
          <div className="onboarding-icon"><Mail /></div>
          <span className="onboarding-kicker">Confirm before T0</span>
          <h1>Use this Outlook mailbox?</h1>
          <p>Boxie validated delegated <code>Mail.Read</code> access without downloading a message body. Confirming creates T0, then immediately stores new Inbox and Sent Items activity as encrypted data on this device.</p>
          <div className="outlook-confirmation">
            <div className="outlook-avatar">{outlook.username.slice(0, 1).toUpperCase()}</div>
            <span><strong>{outlook.displayName ?? "Microsoft account"}</strong><small>{outlook.username}</small></span>
            <ShieldCheck />
          </div>
          <div className="onboarding-actions">
            <button className="onboarding-secondary" type="button" disabled={busy !== null} onClick={() => void run("Clearing selection", async () => {
              await forgetSelectedOutlookAccount(outlook.homeAccountId);
              setOutlook(null);
            })}><ArrowLeft /> Choose another</button>
            <button className="onboarding-primary" type="button" disabled={busy !== null} onClick={() => void activateAndSyncMailbox()}>Use and sync this mailbox <ArrowRight /></button>
          </div>
        </>}

        {started && firebase && user && readyVault && outlook && initialSync && <>
          <div className="onboarding-check onboarding-check-large"><Check /></div>
          <span className="onboarding-kicker">Encrypted inbox ready</span>
          <h1>Boxie is watching from now.</h1>
          <p><strong>{outlook.username}</strong> is connected read-only. Mail after {formatActivationTime(initialSync.activatedAt)} is stored as encrypted canonical data on this device, with durable checkpoints for the next sync.</p>
          <div className="onboarding-sync-summary">
            {initialSync.results.map((result) => (
              <div key={result.folderKind}>
                {result.folderKind === "inbox" ? <Mail /> : <Send />}
                <span>
                  <strong>{result.folderKind === "inbox" ? "Inbox" : "Sent Items"}</strong>
                  <small>{formatSyncResult(result)}</small>
                </span>
              </div>
            ))}
            <div>
              <Database />
              <span><strong>{initialSync.activeMessageCount} encrypted messages</strong><small>Encrypted backup complete · readable only with this vault key</small></span>
            </div>
          </div>
          <div className="onboarding-next-boundary"><LockKeyhole /><span><strong>Still read-only</strong><small>Boxie now projects this encrypted device store into chats and refreshes while the app is open.</small></span></div>
          <a className="onboarding-primary" href="/?browserMailbox=1&cloudMailbox=1">Open encrypted Boxie <ArrowRight /></a>
        </>}
      </section>

      {busy && <div className="onboarding-busy"><LoaderCircle className="spin" /><span>{busy}</span></div>}
      {started && user && firebase && <button className="onboarding-signout" type="button" onClick={() => void signOutUser(firebase)}>Use a different Boxie account</button>}
    </main>
  );
}

function OnboardingLoading({ label }: { label: string }) {
  return <div className="onboarding-loading"><LoaderCircle className="spin" /><strong>{label}</strong><small>This stays on your device.</small></div>;
}

function formatActivationTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatSyncResult(result: BrowserOutlookSyncResult): string {
  if (result.discovered === 0) return `Up to date · ${result.pages} page checked`;
  return `${result.inserted} new · ${result.updated} refreshed · ${result.removed} removed`;
}
