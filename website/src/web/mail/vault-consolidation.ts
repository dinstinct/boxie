import {canonical} from '../../contracts/sync/protocol';
import {decryptJsonObject, deriveOpaqueObjectId, encryptJsonObject} from '../vault-spike/crypto';
import {assertCanonicalMailbox, assertCanonicalMessage, type BrowserCanonicalMailbox, type BrowserCanonicalMessage} from './canonical-types';
import {toWorkingMessage} from './browser-conversation-projection';
import {revisionAAD, type OrganizationTransport} from './sync-v2-organization';

type Vault = {vaultId: string; epoch: number; vaultKey: Uint8Array; deviceId: string};
type Snapshot = {mailbox: BrowserCanonicalMailbox; messages: BrowserCanonicalMessage[]};
const contentType = 'application/vnd.boxie.sync-v2+json';
const tenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
type Reference = {objectId: string; revision: string};
type ImportPayload = {protocol: 2; kind: 'identity'; stream: null; format: 'boxie-local-import-v1';
  sourceVaultId: string; mailbox: BrowserCanonicalMailbox; parts: Reference[]};

/** Additive imports never rewrite a frozen baseline or delete their source.
 * Parts become visible only through the final authenticated manifest. A retry
 * reuses the same content identity; account equality is always the provider ID.
 */
export class VaultConsolidation {
  private readonly decrypted = new Map<string, Promise<Record<string, unknown>>>();
  constructor(private readonly transport: OrganizationTransport, private readonly vault: Vault) {}
  private id(namespace: string, logicalId: string) {return deriveOpaqueObjectId({...this.vault, namespace, logicalId});}
  private async read(ref: Reference) {
    const key = revisionAAD(ref.objectId, ref.revision);
    let pending = this.decrypted.get(key);
    if (!pending) {pending = this.readRevision(ref); this.decrypted.set(key, pending);}
    try {return await pending;} catch (error) {this.decrypted.delete(key); throw error;}
  }
  private async readRevision(ref: Reference) {
    const encrypted = await this.transport.read(ref.objectId, ref.revision);
    if (encrypted.epoch !== this.vault.epoch) throw new Error('Import epoch mismatch');
    return decryptJsonObject<Record<string, unknown>>({...this.vault, objectId: revisionAAD(ref.objectId, ref.revision), encrypted, expectedContentType: contentType});
  }
  private async put(objectId: string, payload: unknown): Promise<Reference> {
    const existing = await this.transport.head(objectId);
    if (existing) {
      if (existing.kind !== 'identity' || existing.epoch !== this.vault.epoch || existing.stream !== null || canonical(await this.read({objectId, revision: existing.revision})) !== canonical(payload)) throw new Error('Import content identity changed');
      return {objectId, revision: existing.revision};
    }
    const revision = crypto.randomUUID();
    await this.transport.stage(objectId, revision, await encryptJsonObject({...this.vault, objectId: revisionAAD(objectId, revision), contentType, payload}));
    try {await this.transport.publish(objectId, {kind: 'identity', revision, baseRevision: null, stream: null, fence: null, owner: this.vault.deviceId});}
    catch (error) {
      const head = await this.transport.head(objectId);
      if (!head || canonical(await this.read({objectId, revision: head.revision})) !== canonical(payload)) throw error;
      return {objectId, revision: head.revision};
    }
    return {objectId, revision};
  }
  async publish(source: Snapshot, sourceVault: {vaultId: string; vaultKey: Uint8Array}, target: BrowserCanonicalMailbox): Promise<void> {
    const mailbox = assertCanonicalMailbox(source.mailbox);
    if (mailbox.providerAccountId !== target.providerAccountId || !mailbox.providerAccountId.endsWith('.' + tenant)) throw new Error('Only the exact same personal Outlook account can be consolidated');
    if (mailbox.provider !== 'outlook' || mailbox.informationSpace !== 'personal' || !Number.isFinite(Date.parse(mailbox.activatedAt)) || !Number.isFinite(Date.parse(target.activatedAt))) throw new Error('Invalid import activation boundary');
    if (sourceVault.vaultId === this.vault.vaultId) return;
    const messages = source.messages.map(raw => {
      const value = assertCanonicalMessage(raw);
      if (value.provider !== 'outlook' || !['inbox', 'sent_items'].includes(value.folderKind) || value.providerPayload?.id !== value.providerMessageId || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid local message');
      if (value.accountScopeId !== mailbox.accountScopeId) throw new Error('Local message belongs to another mailbox');
      return {...value, accountScopeId: target.accountScopeId};
    }).sort((a,b) => `${a.folderKind}:${a.providerMessageId}`.localeCompare(`${b.folderKind}:${b.providerMessageId}`));
    const preferences: BrowserCanonicalMailbox['conversationPreferences'] = {};
    for (const message of source.messages) {
      const key = toWorkingMessage(mailbox, message).conversationKey;
      const oldId = await deriveOpaqueObjectId({vaultKey: sourceVault.vaultKey, namespace: 'browser-conversation', logicalId: `${mailbox.accountScopeId}\0${key}`});
      const newId = await this.id('browser-conversation', `${target.accountScopeId}\0${key}`);
      if (mailbox.conversationPreferences[oldId]) preferences[newId] = mailbox.conversationPreferences[oldId]!;
    }
    const importedMailbox = {...mailbox, accountScopeId: target.accountScopeId, conversationPreferences: preferences};
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({sourceVaultId: sourceVault.vaultId, mailbox: importedMailbox, messages})))), b => b.toString(16).padStart(2, '0')).join('');
    const parts: Reference[] = [];
    // One source record per part keeps large email bodies below transport limits.
    // Oversize records fail before the manifest, leaving local data usable.
    for (const [index, message] of messages.entries()) {
      parts.push(await this.put(await this.id('consolidation-part', `${hash}\0${index}`), {protocol: 2, kind: 'identity', stream: null, format: 'boxie-local-import-part-v1', messages: [message]}));
    }
    const objectId = await this.id('consolidation-import', `${sourceVault.vaultId}\0${hash}`);
    const ref = await this.put(objectId, {protocol: 2, kind: 'identity', stream: null, format: 'boxie-local-import-v1', sourceVaultId: sourceVault.vaultId, mailbox: importedMailbox, parts} satisfies ImportPayload);
    await this.loadManifest(ref, target); // Verify all dependencies before switching workspaces.
  }
  private async loadManifest(ref: Reference, target: BrowserCanonicalMailbox): Promise<Snapshot> {
    const raw = await this.read(ref);
    if (raw.protocol !== 2 || raw.kind !== 'identity' || raw.stream !== null || raw.format !== 'boxie-local-import-v1' || !Array.isArray(raw.parts) || raw.parts.length > 100000) throw new Error('Invalid import manifest');
    const mailbox = assertCanonicalMailbox(raw.mailbox);
    if (mailbox.providerAccountId !== target.providerAccountId || mailbox.accountScopeId !== target.accountScopeId || mailbox.informationSpace !== 'personal' || mailbox.provider !== 'outlook' || !Number.isFinite(Date.parse(mailbox.activatedAt))) throw new Error('Import mailbox identity mismatch');
    const messages: BrowserCanonicalMessage[] = [];
    for (const part of raw.parts as Reference[]) {
      const value = await this.read(part);
      if (value.protocol !== 2 || value.kind !== 'identity' || value.stream !== null || value.format !== 'boxie-local-import-part-v1' || !Array.isArray(value.messages)) throw new Error('Invalid import part');
      for (const item of value.messages) {
        const message = assertCanonicalMessage(item);
        if (message.accountScopeId !== target.accountScopeId) throw new Error('Imported message identity mismatch');
        messages.push(message);
      }
    }
    return {mailbox, messages};
  }
  async load(target: BrowserCanonicalMailbox): Promise<Snapshot[]> {
    if (!this.transport.listHeads) throw new Error('Import discovery unavailable');
    const result: Snapshot[] = [];
    for (const {objectId, head} of (await this.transport.listHeads()).sort((a,b) => a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0)) {
      if (head.kind !== 'identity') continue;
      if (head.protocol !== 2 || head.epoch !== this.vault.epoch || head.stream !== null) throw new Error('Invalid import head');
      const ref = {objectId, revision: head.revision};
      const payload = await this.read(ref);
      if (payload.format === 'boxie-local-import-v1') result.push(await this.loadManifest(ref, target));
    }
    return result;
  }
}

/** Shared import ordering: provider revisions first, observations second. An
 * explicit removal wins equal versions. Imported pre-baseline mail survives a
 * reset made by an older client with a later activation boundary.
 */
export function mergeImportedMessages(existing: BrowserCanonicalMessage[], imports: BrowserCanonicalMessage[], baselineActivation: string): BrowserCanonicalMessage[] {
  const key = (m: BrowserCanonicalMessage) => `${m.accountScopeId}\0${m.folderKind}\0${m.providerMessageId}`;
  const values = new Map(existing.map(m => [key(m), m]));
  for (const item of imports) {
    const old = values.get(key(item));
    const olderReset = old?.providerRemovedReason === 'absent_after_reset' && Date.parse(item.providerPayload.receivedDateTime ?? '') < Date.parse(old.providerResetActivatedAt ?? baselineActivation);
    const compare = (a: BrowserCanonicalMessage, b: BrowserCanonicalMessage) =>
      ((Date.parse(a.providerPayload.lastModifiedDateTime ?? '') || 0) - (Date.parse(b.providerPayload.lastModifiedDateTime ?? '') || 0)) ||
      ((Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0)) || Number(Boolean(a.providerRemovedAt)) - Number(Boolean(b.providerRemovedAt));
    if (!old || olderReset || compare(item, old) > 0) values.set(key(item), item);
  }
  return [...values.values()];
}
