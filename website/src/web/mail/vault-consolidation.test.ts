import {describe, expect, it} from 'vitest';
import {VaultConsolidation, mergeImportedMessages} from './vault-consolidation';
import type {OrganizationTransport} from './sync-v2-organization';
import type {SyncHead} from './sync-v2-store';
import type {EncryptedObject} from '../vault-spike/types';
import {deriveOpaqueObjectId} from '../vault-spike/crypto';
import type {BrowserCanonicalMailbox, BrowserCanonicalMessage} from './canonical-types';
import {SyncedOrganization} from './sync-v2-organization';

class Transport implements OrganizationTransport {
  heads = new Map<string, SyncHead>();
  revisions = new Map<string, EncryptedObject>();
  failAfter = Infinity;
  writes = 0;
  async head(id: string) {return structuredClone(this.heads.get(id) ?? null);}
  async listHeads() {return [...this.heads].map(([objectId, head]) => ({objectId, head}));}
  async read(id: string, revision: string) {const value = this.revisions.get(`${id}:${revision}`); if (!value) throw new Error('missing'); return value;}
  async stage(id: string, revision: string, value: EncryptedObject) {this.revisions.set(`${id}:${revision}`, value);}
  async publish(id: string, value: Omit<SyncHead, 'protocol' | 'epoch' | 'sequence'>) {
    if (this.writes >= this.failAfter) throw new Error('interrupted');
    const old = this.heads.get(id);
    if ((old?.revision ?? null) !== value.baseRevision) throw new Error('changed');
    this.heads.set(id, {...value, protocol: 2, epoch: 1, sequence: (old?.sequence ?? 0) + 1}); this.writes++;
  }
}
const vault = {vaultId: 'shared-vault', epoch: 1, deviceId: 'browser', vaultKey: new Uint8Array(32).fill(7)};
const sourceVault = {vaultId: 'local-vault', vaultKey: new Uint8Array(32).fill(8)};
async function fixture() {
  const providerAccountId = 'fixture.9188040d-6c67-4c5b-b112-36a304b66dad';
  const scope = (key: Uint8Array) => deriveOpaqueObjectId({vaultKey: key, namespace: 'canonical-outlook-account', logicalId: providerAccountId});
  const cursor = {deltaLink: null, lastStartedAt: null, lastCompletedAt: null, lastError: null};
  const mailbox: BrowserCanonicalMailbox = {schemaVersion: 1, messageStorageRevision: 2, kind: 'boxie-canonical-mailbox',
    accountScopeId: await scope(sourceVault.vaultKey), provider: 'outlook', providerAccountId, emailAddress: 'owner@example.com', informationSpace: 'personal',
    activatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
    cursors: {inbox: cursor, sent_items: cursor}, conversationPreferences: {}};
  const message: BrowserCanonicalMessage = {schemaVersion: 2, kind: 'boxie-canonical-message', provider: 'outlook', accountScopeId: mailbox.accountScopeId,
    providerMessageId: 'm1', folderKind: 'inbox', direction: 'incoming', observedAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    providerPayload: {id: 'm1', receivedDateTime: '2026-09-02T00:00:00Z', lastModifiedDateTime: '2026-09-02T00:00:00Z', from: {emailAddress: {address: 'sender@example.com'}}, subject: 'Synthetic private message'},
    providerRemovedAt: null, providerRemovedReason: null};
  const target = {...mailbox, accountScopeId: await scope(vault.vaultKey), activatedAt: '2026-09-03T00:00:00Z', conversationPreferences: {}};
  const oldId = await deriveOpaqueObjectId({vaultKey: sourceVault.vaultKey, namespace: 'browser-conversation', logicalId: `${mailbox.accountScopeId}\0person:sender@example.com`});
  const newId = await deriveOpaqueObjectId({vaultKey: vault.vaultKey, namespace: 'browser-conversation', logicalId: `${target.accountScopeId}\0person:sender@example.com`});
  mailbox.conversationPreferences[oldId] = {customName: 'Local sender', admission: 'accepted'};
  return {mailbox, message, target, oldId, newId};
}
describe('local mailbox consolidation', () => {
  it('verifies the encrypted import, remaps organization, retains source and retries without duplicate writes', async () => {
    const f = await fixture(), transport = new Transport(), importer = new VaultConsolidation(transport, vault);
    const original = structuredClone(f);
    await importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, f.target);
    const loaded = await importer.load(f.target);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.mailbox.activatedAt).toBe(f.mailbox.activatedAt);
    expect(loaded[0]!.messages[0]!.accountScopeId).toBe(f.target.accountScopeId);
    expect(loaded[0]!.mailbox.conversationPreferences[f.newId]).toEqual(f.mailbox.conversationPreferences[f.oldId]);
    expect(f).toEqual(original);
    expect(JSON.stringify([...transport.revisions])).not.toContain('Synthetic private message');
    const writes = transport.writes;
    await importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, f.target);
    expect(transport.writes).toBe(writes);
    const organization = new SyncedOrganization(transport, vault);
    await organization.initialize(f.newId, {customName: 'Shared choice'}, 'existing');
    await organization.initialize(f.newId, {...loaded[0]!.mailbox.conversationPreferences[f.newId]}, 'import');
    expect((await organization.load(f.newId)).state.fields.customName?.value).toBe('Shared choice');
  });
  it('publishes no visible partial import, and resumes after an interrupted upload', async () => {
    const f = await fixture(), transport = new Transport(), importer = new VaultConsolidation(transport, vault);
    transport.failAfter = 1;
    await expect(importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, f.target)).rejects.toThrow('interrupted');
    expect(await importer.load(f.target)).toEqual([]);
    transport.failAfter = Infinity;
    await importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, f.target);
    expect((await importer.load(f.target))[0]!.messages).toHaveLength(1);
    expect(transport.writes).toBe(2);
  });
  it('rejects a different Microsoft identity even with the same email, before writing', async () => {
    const f = await fixture(), transport = new Transport(), importer = new VaultConsolidation(transport, vault);
    await expect(importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, {...f.target, providerAccountId: 'different'})).rejects.toThrow('exact same');
    expect(transport.writes).toBe(0);
  });
  it('deduplicates imports, respects newer provider changes and explicit removals, and protects earlier coverage from old-client resets', async () => {
    const {message, target} = await fixture();
    const newer = {...message, providerPayload: {...message.providerPayload, lastModifiedDateTime: '2026-09-04T00:00:00Z'}};
    expect(mergeImportedMessages([newer], [message, message], target.activatedAt)).toEqual([newer]);
    const removed = {...message, updatedAt: '2026-09-04T00:00:00Z', providerRemovedAt: '2026-09-04T00:00:00Z', providerRemovedReason: 'deleted'};
    expect(mergeImportedMessages([removed], [message], target.activatedAt)).toEqual([removed]);
    expect(mergeImportedMessages([{...removed, providerRemovedReason: 'absent_after_reset'}], [message], target.activatedAt)).toEqual([message]);
    const currentReset = {...removed, providerRemovedReason: 'absent_after_reset', providerResetActivatedAt: '2026-09-01T00:00:00Z'};
    expect(mergeImportedMessages([currentReset], [message], target.activatedAt)).toEqual([currentReset]);
  });
  it('fails closed if an acknowledged part is missing or authenticated for another vault', async () => {
    const f = await fixture(), transport = new Transport(), importer = new VaultConsolidation(transport, vault);
    await importer.publish({mailbox: f.mailbox, messages: [f.message]}, sourceVault, f.target);
    await expect(new VaultConsolidation(transport, {...vault, vaultId: 'other-vault'}).load(f.target)).rejects.toThrow();
    transport.revisions.delete([...transport.revisions.keys()][0]!);
    await expect(new VaultConsolidation(transport, vault).load(f.target)).rejects.toThrow('missing');
  });
});
