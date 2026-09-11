import 'fake-indexeddb/auto';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {activateLocalMailbox, localAccountUid, openLocalMailbox, personalTenant} from './local-mailbox';
import {loadLocalVault, readLocalVaultKey} from '../vault-spike/local-store';
import {IndexedDbEncryptedCanonicalRepository} from '../mail/encrypted-canonical-repository';
import {BrowserCanonicalMailStore} from '../mail/browser-canonical-mail-store';

vi.mock('./microsoft-browser', () => ({getOutlookAccessToken: async () => 'synthetic-token'}));
const values = new Map<string,string>();
const account = {homeAccountId:'personal-test',tenantId:personalTenant,username:'owner@example.com',displayName:null};
beforeEach(() => {
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  vi.stubGlobal('navigator',{locks:{request:async (_name:string,fn:()=>unknown)=>fn()}});
});
describe('Outlook local mailbox boundary', () => {
  it('creates and restores encrypted mail without cloud replication and preserves T0 on reconnect', async () => {
    const client = await activateLocalMailbox(account);
    const uid = await localAccountUid(account);
    const vault = (await loadLocalVault(uid))!;
    const key = await readLocalVaultKey(vault);
    const repository = new IndexedDbEncryptedCanonicalRepository(uid,vault.vaultId,false);
    const store = BrowserCanonicalMailStore.create({localVault:vault,vaultKey:key,repository});
    const [mailbox] = await store.listMailboxes();
    const record = (await repository.listAll())[0]!;
    expect(JSON.stringify(record)).not.toContain(account.username);
    expect(await repository.pendingCount()).toBe(0);
    expect((await client.getSyncStatus()).encryptedReplica).toBeUndefined();
    await activateLocalMailbox(account);
    expect((await loadLocalVault(uid))!.vaultId).toBe(vault.vaultId);
    expect((await store.listMailboxes())[0]!.activatedAt).toBe(mailbox!.activatedAt);
    expect(await openLocalMailbox()).not.toBeNull();
  });
  it('ingests Graph mail into the real projection and restores it offline with no Firebase requests', async () => {
    const client = await activateLocalMailbox({...account,homeAccountId:'graph-fixture'});
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      expect(String(url)).toContain('https://graph.microsoft.com/');
      const incoming = String(url).includes('Inbox');
      return Response.json({value: incoming ? [{id:'fixture-message',conversationId:'fixture-thread',
        subject:'A real projection fixture',body:{contentType:'text',content:'Hello from the Graph fixture'},
        from:{emailAddress:{name:'Fixture sender',address:'sender@example.com'}},
        toRecipients:[{emailAddress:{address:account.username}}],
        receivedDateTime:new Date(Date.now()+1000).toISOString(),isRead:false}] : [],
        '@odata.deltaLink': String(url)});
    });
    await client.refresh();
    expect(calls).toHaveLength(2);
    expect(calls.every(url => new URL(url).searchParams.get('$filter')?.includes('receivedDateTime ge'))).toBe(true);
    expect(JSON.stringify(await client.loadIndex())).toContain('Fixture sender');
    vi.stubGlobal('fetch', () => {throw new Error('Offline');});
    const restored = (await openLocalMailbox())!;
    expect(JSON.stringify(await restored.loadIndex())).toContain('Fixture sender');
    expect((await restored.getSyncStatus()).encryptedReplica).toBeUndefined();
  });
  it('isolates different Microsoft identities even when email addresses match', async () => {
    await activateLocalMailbox(account);
    const other = {...account,homeAccountId:'different-personal-account'};
    await activateLocalMailbox(other);
    const a = await loadLocalVault(await localAccountUid(account));
    const b = await loadLocalVault(await localAccountUid(other));
    expect(a!.vaultId).not.toBe(b!.vaultId);
    expect(a!.wrappedVaultKey).not.toBe(b!.wrappedVaultKey);
  });
  it('rejects work accounts before storing any identity and never opens a cloud uid as local', async () => {
    const previous = values.get('boxie.localMailbox.v1');
    await expect(activateLocalMailbox({...account,tenantId:'work-tenant'})).rejects.toThrow('personal Outlook');
    expect(values.get('boxie.localMailbox.v1')).toBe(previous);
    await expect(openLocalMailbox('firebase-owner')).rejects.toThrow('invalid');
  });
});
