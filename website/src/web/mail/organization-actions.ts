import {openDB} from "idb";
import {canonical, type Operation, type Organization} from "../../contracts/sync/protocol";
import {encryptJsonObject, decryptJsonObject} from "../vault-spike/crypto";
import type {EncryptedObject} from "../vault-spike/types";
import type {BrowserConversationPreference} from "./canonical-types";
import type {SyncedOrganization} from "./sync-v2-organization";

const fields = ["archivedAt", "customName", "admission", "moderation", "locallyReadMessageIds", "locallyUnreadMessageIds"] as const;
export interface OrganizationJournal {
  put(operation: Operation): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<Operation[]>;
}
export class EncryptedOrganizationJournal implements OrganizationJournal {
  private readonly database = openDB("boxie-organization-outbox-v2", 1, {upgrade(db) {db.createObjectStore("operations");}});
  constructor(private readonly vault: {uid: string; vaultId: string; epoch: number; vaultKey: Uint8Array}) {}
  private key(id: string) {return `${this.vault.uid}:${this.vault.vaultId}:${this.vault.epoch}:${id}`;}
  async put(operation: Operation) {
    const encrypted = await encryptJsonObject({...this.vault, objectId: this.key(operation.id), contentType: "application/vnd.boxie.sync-v2+json", payload: operation});
    await (await this.database).put("operations", encrypted, this.key(operation.id));
  }
  async remove(id: string) {await (await this.database).delete("operations", this.key(id));}
  async list() {
    const db = await this.database;
    const keys = await db.getAllKeys("operations");
    const result: Operation[] = [];
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(this.key(""))) continue;
      const encrypted: EncryptedObject = await db.get("operations", key);
      const operation = await decryptJsonObject<Operation>({...this.vault, objectId: key, encrypted, expectedContentType: "application/vnd.boxie.sync-v2+json"});
      if (key !== this.key(operation.id)) throw new Error("Outbox identity mismatch");
      result.push(operation);
    }
    return result;
  }
}
export function preferenceFromOrganization(state: Organization): BrowserConversationPreference {
  return Object.fromEntries(fields.filter(key => state.fields[key]).map(key => [key, state.fields[key]!.value])) as BrowserConversationPreference;
}
export function preferenceOperation(state: Organization, next: BrowserConversationPreference): Operation | null {
  const changes: Operation["changes"] = {};
  for (const field of fields) {
    if (next[field] === undefined) continue;
    const previous = state.fields[field];
    if (previous && canonical(previous.value) === canonical(next[field])) continue;
    changes[field] = {expected: previous?.revision ?? null, value: structuredClone(next[field])};
  }
  return Object.keys(changes).length ? {id: crypto.randomUUID(), target: state.target, changes} : null;
}
/** One action queue per UI instance. Cross-device/tab writes are still resolved
 * by the repository's conditional head, not by this local serialization. */
export class OrganizationActions {
  private readonly bases = new Map<string, Organization>();
  private active: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: Pick<SyncedOrganization, "load" | "apply"> & Partial<Pick<SyncedOrganization, "initialize" | "loadMany">>, private readonly journal: OrganizationJournal) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.active.catch(() => undefined).then(work);
    this.active = next;
    return next;
  }
  async refresh(targets: string[], baseline?: Record<string, BrowserConversationPreference>): Promise<Record<string, BrowserConversationPreference>> {
    return this.serial(async () => {
      await this.flush();
      const values: Record<string, BrowserConversationPreference> = {};
      const loaded = await this.repository.loadMany?.(targets);
      for (const target of targets) {
        let {head, state} = loaded?.[target] ?? await this.repository.load(target);
        if (!head && baseline && this.repository.initialize) ({head, state} = await this.repository.initialize(target, {...baseline[target]}, "frozen-baseline"));
        if (!head) throw new Error("Conversation organization has not been migrated. No legacy write was made.");
        this.bases.set(target, state);
        values[target] = preferenceFromOrganization(state);
      }
      return values;
    });
  }
  async edit(target: string, update: (current: BrowserConversationPreference) => BrowserConversationPreference): Promise<BrowserConversationPreference> {
    return this.serial(async () => {
      const base = this.bases.get(target);
      if (!base) throw new Error("Refresh this conversation before changing it.");
      const operation = preferenceOperation(base, update(preferenceFromOrganization(base)));
      if (operation) {
        // Preserve click-time field revisions and message IDs before any network call.
        await this.journal.put(operation);
        try { await this.flush(); }
        catch (error) {
          if ((await this.journal.list()).some(item => item.id === operation.id)) throw new Error("Change saved on this browser; sync pending. " + (error instanceof Error ? error.message : "Could not reach your vault."));
          throw error;
        }
      }
      const {state} = await this.repository.load(target);
      this.bases.set(target, state);
      return preferenceFromOrganization(state);
    });
  }
  private async flush() {
    for (const operation of await this.journal.list()) {
      const result = await this.repository.apply(operation);
      await this.journal.remove(operation.id);
      if (result.status === "conflict") throw new Error("This change conflicts with an edit on another device. Refresh and apply your choice again.");
    }
  }
}
