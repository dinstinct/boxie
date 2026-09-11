import {useEffect, useState} from 'react';
import {App} from '../App';
import {OnboardingApp} from './OnboardingApp';
import type {BrowserMailboxClient} from '../mail/browser-mailbox-client';
import {CloudMailboxApp} from '../mail/BrowserMailboxApp';
import {hasSavedCloudVault} from '../vault-spike/local-store';
import {activateLocalMailbox, openLocalMailbox} from './local-mailbox';
import {chooseOutlookAccount, consumeOutlookRedirectAccount, hasPendingOutlookRedirect, microsoftBrowserClientId} from './microsoft-browser';
import './onboarding.css';

type Entry = {kind:'local'; client:BrowserMailboxClient} | {kind:'cloud'} | {kind:'welcome'} | {kind:'cloud-setup'};
// Redirect consumption and key initialization must happen only once, including
// React StrictMode's effect replay. No Firebase operation participates in setup.
let entryPromise: Promise<Entry> | undefined;
async function resolveEntry(): Promise<Entry> {
  const params = new URLSearchParams(location.search);
  if (params.get('onboarding') === '1' && (hasPendingOutlookRedirect() || params.has('recovered'))
      && await hasSavedCloudVault()) return {kind:'cloud-setup'};
  if (hasPendingOutlookRedirect()) {
    const account = await consumeOutlookRedirectAccount();
    if (account) {
      const client = await activateLocalMailbox(account);
      await client.refresh().catch(() => undefined); // Keep a usable inbox and visible sync error for retry.
      return {kind:'local', client};
    }
  }
  if (new URLSearchParams(location.search).get('cloudMailbox') === '1') return {kind:'cloud'};
  const client = await openLocalMailbox();
  if (client) return {kind:'local', client};
  // Restore existing cloud users without requiring Firebase for a fresh user.
  if (!await hasSavedCloudVault()) return {kind:'welcome'};
  const {onboardingFirebaseClient} = await import('./vault-setup');
  const firebase = onboardingFirebaseClient();
  if (firebase) {
    await firebase.auth.authStateReady();
    if (!new URLSearchParams(location.search).has('onboarding') && firebase.auth.currentUser && !firebase.auth.currentUser.isAnonymous) return {kind:'cloud'};
  }
  return {kind:'welcome'};
}

export function LocalMailboxApp() {
  const [entry,setEntry] = useState<Entry>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    entryPromise ??= resolveEntry();
    void entryPromise.then(result => {if(active)setEntry(result);}).catch(e => {
      entryPromise = undefined;
      if(active) {setEntry({kind:'welcome'});setError(e instanceof Error ? e.message : 'Could not open this inbox.');}
    });
    return () => {active=false;};
  },[]);
  if(entry?.kind === 'cloud-setup') return <OnboardingApp />;
  if(entry?.kind === 'cloud') return <CloudMailboxApp />;
  if(entry?.kind === 'local' && !new URLSearchParams(location.search).has('onboarding')) return <App mailboxClient={entry.client} />;
  return <main className="onboarding-shell">
    <header className="onboarding-header"><a href="/"><img src="/brand/boxie-icon.png" alt=""/><strong>Boxie</strong></a><a href="/feedback">Feedback / support</a></header>
    <section className="onboarding-card">
      <span className="onboarding-kicker">Your personal Outlook, as conversations</span>
      <h1>{!entry ? 'Opening your inbox…' : 'Connect Outlook. Meet your Boxie inbox.'}</h1>
      <p>Connect your personal Microsoft account to read new mail in Boxie. Your inbox is encrypted on this browser. No Google account or cloud vault is needed.</p>
      <p>Boxie starts with new incoming mail and Sent Items from the moment you connect. Older messages are not imported. Boxie cannot send, delete, or change your Outlook mail.</p>
      <button className="onboarding-primary" disabled={!entry || busy || !microsoftBrowserClientId()} onClick={() => {
        setBusy(true);setError('');
        void chooseOutlookAccount('/app').catch(e => {setBusy(false);setError(e instanceof Error ? e.message : 'Microsoft sign-in failed. Please retry.');});
      }}>{busy ? 'Connecting Outlook…' : 'Connect personal Outlook'}</button>
      {!microsoftBrowserClientId() && <p role="status">Outlook connection is unavailable on this installation. Contact support@dionlabs.ai.</p>}
      {error && <p role="alert">{error}</p>}
      {entry?.kind === 'local' && <p><a href="/app">Return to your saved inbox</a></p>}
      <p style={{marginTop:24}}>Local storage belongs to this browser profile. Clearing browser data removes this copy and its encryption key. Cloud backup and additional devices are optional.</p>
      <a href="/?cloudVault=1">Use an existing cloud vault or set up multi-device sync</a>
    </section>
  </main>;
}
