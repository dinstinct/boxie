import './account-deletion.css';
import {useEffect, useState} from 'react';
import {GoogleAuthProvider, reauthenticateWithPopup, type User} from 'firebase/auth';
import {doc, getDocFromServer, runTransaction, serverTimestamp} from 'firebase/firestore';
import {createFirebaseSpikeClient, signInWithGoogle, subscribeToUser, signOutUser} from '../vault-spike/firebase-client';

export function AccountDeletion() {
  const [client] = useState(createFirebaseSpikeClient);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {document.title = 'Delete your account — Boxie';}, []);
  useEffect(() => client ? subscribeToUser(client, value => {setUser(value); setStatus(''); setConfirmation(''); setError('');}) : undefined, [client]);
  useEffect(() => {
    let active = true;
    if (client && user) getDocFromServer(doc(client.db, 'boxieDeletion', user.uid)).then(snapshot => {
      if (active) setStatus(snapshot.exists() ? String(snapshot.data().status) : 'none');
    }).catch(() => {if (active) setError('Cannot check your request right now. Please retry or email support@dionlabs.ai.');});
    return () => {active = false;};
  }, [client, user]);
  async function submit() {
    if (!client || !user || confirmation !== 'DELETE' || status !== 'none') return;
    setBusy(true); setError('');
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({prompt: 'select_account'});
      await reauthenticateWithPopup(user, provider);
      if (client.auth.currentUser?.uid !== user.uid) throw new Error('Account changed. Please reload before continuing.');
      const ref = doc(client.db, 'boxieDeletion', user.uid);
      const recordedStatus = await runTransaction(client.db, async tx => {
        const existing = await tx.get(ref);
        if (!existing.exists()) {
          const root = doc(client.db, 'boxie', user.uid);
          const account = await tx.get(root);
          if (account.exists()) tx.update(root, {deletionRequested: true});
          tx.set(ref, {version: 1, status: 'requested', requestedAt: serverTimestamp()});
          return 'requested';
        }
        return String(existing.data().status);
      });
      setStatus(recordedStatus);
    } catch {
      setError('The request could not be confirmed. Reload this page to check its status before retrying. You can also contact support@dionlabs.ai.');
    } finally {setBusy(false);}
  }
  return <main className="account-deletion"><article>
    <a href="/">← Boxie</a>
    <h1>Delete your Boxie account</h1>
    <p>This permanently removes your Boxie cloud account, encrypted mailbox copies, assistant history, preferences, devices and pairing requests. Your original Outlook mail, Google account and other DionLabs apps are not deleted.</p>
    <p>Submitting a request immediately stops Boxie cloud access for all your devices. DionLabs then processes the cloud deletion manually, normally within 7 days. This cannot be undone; this account cannot start another Boxie vault while the deletion record remains.</p>
    <p>Offline copies cannot be erased remotely. Uninstall Boxie and clear its app data on each device; clear Boxie site data in each browser. On Mac, quit Boxie, remove its application-support data and its Boxie Keychain entries; uninstalling alone does not remove those. Revoke Boxie’s Microsoft access in your Microsoft account settings. Data previously sent to an AI provider is subject to that provider’s deletion process.</p>
    <p>We retain indefinitely a minimal record containing your account identifier and request/completion timestamps to prevent old devices from recreating deleted data. It contains no email contents or credentials.</p>
    {!client ? <p>Account service unavailable. Email <a href="mailto:support@dionlabs.ai?subject=Boxie%20account%20deletion">support@dionlabs.ai</a> to request deletion.</p> : !user ?
      <button disabled={busy} onClick={async () => {setBusy(true); setError(''); try {await signInWithGoogle(client);} catch {setError('Sign-in did not complete. Try again or contact support.');} finally {setBusy(false);}}}>Sign in with Google to request deletion</button> : <>
      <p>Signed in as <strong>{user.email}</strong></p>
      {!status && !error && <p role="status">Checking your deletion request…</p>}
      {status === 'requested' ? <p role="status"><strong>Deletion requested.</strong> Cloud access is blocked. Return here to check completion. Contact support if it has been more than 7 days.</p> : status === 'completed' ? <p role="status"><strong>Your Boxie cloud data has been deleted.</strong> Remember to remove local copies from your devices.</p> : <>
        <label>Type DELETE to confirm <input value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>
        <p><button disabled={busy || status !== 'none' || confirmation !== 'DELETE'} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Request permanent deletion'}</button></p>
      </>}
      <button disabled={busy} onClick={() => void signOutUser(client)}>Sign out</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <p>Cannot sign in? Email <a href="mailto:support@dionlabs.ai?subject=Boxie%20account%20deletion">support@dionlabs.ai</a> with the subject “Boxie account deletion” and the Google email you use for Boxie. We will verify ownership before deleting anything. Never send passwords, tokens, mailbox contents or vault keys.</p>
    <a href="/privacy">Privacy and your data</a>
  </article></main>;
}
