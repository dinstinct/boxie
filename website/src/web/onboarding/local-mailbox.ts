import {createAndSaveLocalVault, loadLocalVault, readLocalVaultKey} from '../vault-spike/local-store';
import {randomBytes, randomId} from '../vault-spike/crypto';
import {BrowserCanonicalMailStore} from '../mail/browser-canonical-mail-store';
import {IndexedDbEncryptedCanonicalRepository} from '../mail/encrypted-canonical-repository';
import {BrowserMailboxClient} from '../mail/browser-mailbox-client';
import type {SelectedOutlookAccount} from './microsoft-browser';

const activeKey = 'boxie.localMailbox.v1';
const prefix = 'local-outlook-';
export const personalTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';

export async function localAccountUid(account: SelectedOutlookAccount): Promise<string> {
  if (account.tenantId !== personalTenant) throw new Error('Connect a personal Outlook account. Work and school mailboxes are not supported and stay separate.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account.homeAccountId));
  return prefix + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function openLocalMailbox(uid = localStorage.getItem(activeKey)): Promise<BrowserMailboxClient | null> {
  if (!uid) return null;
  if (!uid.startsWith(prefix)) throw new Error('The local mailbox reference is invalid. Your saved data has not been changed.');
  const local = await loadLocalVault(uid);
  if (!local) throw new Error('This browser’s local encryption key is missing. Reconnect Outlook to start a new local inbox.');
  const vaultKey = await readLocalVaultKey(local);
  const store = BrowserCanonicalMailStore.create({localVault: local, vaultKey,
    repository: new IndexedDbEncryptedCanonicalRepository(uid, local.vaultId, false)});
  const mailboxes = await store.listMailboxes();
  if (mailboxes.length !== 1) throw new Error('The local mailbox identity needs review. Nothing was replaced.');
  return BrowserMailboxClient.create({store, vaultKey, mailbox: mailboxes[0]!});
}

export async function activateLocalMailbox(account: SelectedOutlookAccount): Promise<BrowserMailboxClient> {
  const uid = await localAccountUid(account);
  // Serialize across tabs: never replace a key after another tab has begun writing.
  return navigator.locks.request(`boxie-local-setup-${uid}`, async () => {
    let local = await loadLocalVault(uid);
    if (!local) local = await createAndSaveLocalVault({uid, vaultId: randomId('local'), epoch: 1,
      vaultKey: randomBytes(32), deviceName: 'This browser'});
    const vaultKey = await readLocalVaultKey(local);
    const store = BrowserCanonicalMailStore.create({localVault: local, vaultKey,
      repository: new IndexedDbEncryptedCanonicalRepository(uid, local.vaultId, false)});
    const existing = await store.listMailboxes();
    if (existing.some(mailbox => mailbox.providerAccountId !== account.homeAccountId)) {
      throw new Error('This encrypted store belongs to another Outlook account. Nothing was merged.');
    }
    await store.activateOutlookAccount({providerAccountId: account.homeAccountId,
      emailAddress: account.username, activatedAt: new Date().toISOString()});
    const client = await openLocalMailbox(uid);
    if (!client) throw new Error('Local mailbox initialization did not finish. Please retry.');
    localStorage.setItem(activeKey, uid);
    return client;
  });
}
