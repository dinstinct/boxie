import {readSyncCache, writeSyncCache} from './sync-read-cache';
import {canonical} from "../../contracts/sync/protocol";
import {collection, doc, getDocFromCache, query, where, getDocFromServer, getDocsFromServer, runTransaction, serverTimestamp, setDoc, Timestamp, type Firestore} from "firebase/firestore";
import type {EncryptedObject} from "../vault-spike/types";

export type SyncKind = "identity" | "source" | "checkpoint" | "organization" | "assistant";
export interface SyncHead {
  protocol: 2;
  epoch: number;
  kind: SyncKind;
  revision: string;
  baseRevision: string | null;
  sequence: number;
  stream: string | null;
  fence: number | null;
  owner: string;
}
export class SyncWriteConflict extends Error {}
export class SyncLeaseBusy extends Error {}
export interface IngestionLease {stream: string; owner: string; fence: number; expiresAt: number}

const safeID = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid sync path identity");
  return id;
};
/** Staged v2 transport, deliberately not connected to v1 writers. Uses server
 * reads and conditional transactions; offline intent belongs in a durable outbox.
 * The encrypted object's AAD must bind objectId + revision before calling stage.
 */
export class SyncV2Store {
  private readonly path: string;
  private heads = new Map<string, SyncHead>();
  private restored = false;
  private get cacheKey() {return `${this.db.app.options.projectId}/${this.path}/${this.epoch}/heads`;}
  private headWatermark: Timestamp | null = null;
  private headPull: Promise<Array<{objectId: string; head: SyncHead}>> | null = null;
  private async immutable(path: string) {
    const ref = doc(this.db, path);
    try {
      const cached = await getDocFromCache(ref);
      if (cached.exists() && !cached.metadata.hasPendingWrites) return cached;
    } catch { /* Cache eviction is a miss, never an empty revision. */ }
    return getDocFromServer(ref);
  }
  constructor(private readonly db: Firestore, uid: string, vault: string, private readonly epoch: number) {
    this.path = `boxie/${safeID(uid)}/vaults/${safeID(vault)}`;
  }
  async rollout(): Promise<{phase: "preparing" | "frozen" | "active"; migrationOwner: string} | null> {
    const result = await getDocFromServer(doc(this.db, `${this.path}/syncControl/rollout`));
    if (!result.exists()) return null;
    const data = result.data();
    if (data.protocol !== 2 || data.epoch !== this.epoch || !["preparing", "frozen", "active"].includes(data.phase)) throw new Error("Invalid rollout control");
    return {phase: data.phase, migrationOwner: data.migrationOwner};
  }
  /** Administrative migration API; callers must verify compatible installed
   * clients and drained legacy queues BEFORE freezing. No runtime calls this. */
  async transitionRollout(migrationOwner: string, expected: "preparing" | "frozen" | null, phase: "preparing" | "frozen" | "active") {
    safeID(migrationOwner);
    const ref = doc(this.db, `${this.path}/syncControl/rollout`);
    await runTransaction(this.db, async tx => {
      const current = await tx.get(ref);
      if ((current.exists() ? current.get("phase") : null) !== expected
        || (current.exists() && (current.get("migrationOwner") !== migrationOwner || current.get("epoch") !== this.epoch))) {
        throw new SyncWriteConflict("Rollout changed");
      }
      tx.set(ref, {protocol: 2, epoch: this.epoch, phase, migrationOwner, updatedAt: serverTimestamp()});
    });
  }
  /** Sample Firestore time rather than trusting a phone's wall clock. Rules
   * independently validate expiry at commit; a delayed sample fails closed. */
  private async serverTime(): Promise<number> {
    const ref = doc(this.db, `${this.path}/syncClocks/sample`);
    await setDoc(ref, {protocol: 2, epoch: this.epoch, updatedAt: serverTimestamp()});
    const sample = await getDocFromServer(ref);
    const timestamp = sample.get("updatedAt");
    if (!(timestamp instanceof Timestamp)) throw new Error("Server clock unavailable");
    return timestamp.toMillis();
  }
  async acquire(stream: string, owner: string): Promise<IngestionLease> {
    safeID(stream); safeID(owner);
    const ref = doc(this.db, `${this.path}/syncLeases/${stream}`);
    const now = await this.serverTime();
    return runTransaction(this.db, async tx => {
      const old = await tx.get(ref);
      if (old.exists() && old.get("epoch") !== this.epoch) throw new SyncWriteConflict("Old ingestion epoch");
      const active = old.exists() && old.get("expiresAt").toMillis() > now;
      if (active && old.get("owner") !== owner) throw new SyncLeaseBusy("Another device is syncing this folder");
      const fence = active ? old.get("fence") : (old.exists() ? old.get("fence") : 0) + 1;
      const expiresAt = now + 90_000;
      tx.set(ref, {protocol: 2, epoch: this.epoch, owner, fence,
        expiresAt: Timestamp.fromMillis(expiresAt), updatedAt: serverTimestamp()});
      return {stream, owner, fence, expiresAt};
    });
  }
  /** Renewal never silently reacquires an expired lease. The caller must restart
   * from the durable checkpoint after ownership is lost. */
  async renew(lease: IngestionLease): Promise<IngestionLease> {
    const now = await this.serverTime();
    const ref = doc(this.db, `${this.path}/syncLeases/${safeID(lease.stream)}`);
    return runTransaction(this.db, async tx => {
      const current = await tx.get(ref);
      if (!current.exists() || current.get("epoch") !== this.epoch || current.get("owner") !== lease.owner
        || current.get("fence") !== lease.fence || current.get("expiresAt").toMillis() <= now) {
        throw new SyncWriteConflict("Ingestion ownership expired or changed");
      }
      const expiresAt = now + 90_000;
      tx.update(ref, {expiresAt: Timestamp.fromMillis(expiresAt), updatedAt: serverTimestamp()});
      return {...lease, expiresAt};
    });
  }
  async head(objectId: string): Promise<SyncHead | null> {
    const result = await getDocFromServer(doc(this.db, `${this.path}/syncHeads/${safeID(objectId)}`));
    return result.exists() ? result.data() as SyncHead : null;
  }
  async listHeads(): Promise<Array<{objectId: string; head: SyncHead}>> {
    if (this.headPull) return this.headPull;
    this.headPull = (async () => {
      if (!this.restored) {
        const saved = await readSyncCache<{version: number; heads: Array<[string, SyncHead]>; seconds: number; nanoseconds: number}>(this.cacheKey);
        if (saved?.version === 1 && Array.isArray(saved.heads) && saved.heads.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(entry[0]) && entry[1]?.protocol === 2 && entry[1]?.epoch === this.epoch) && Number.isInteger(saved.seconds) && Number.isInteger(saved.nanoseconds) && saved.nanoseconds >= 0 && saved.nanoseconds < 1e9 && saved.seconds >= -62135596800 && saved.seconds < 253402300800) {
          this.heads = new Map(saved.heads); this.headWatermark = new Timestamp(saved.seconds, saved.nanoseconds);
        }
        this.restored = true;
      }
      const collectionRef = collection(this.db, `${this.path}/syncHeads`);
      // Inclusive boundary preserves distinct heads with identical commit times.
      const result = await getDocsFromServer(this.headWatermark
        ? query(collectionRef, where("updatedAt", ">=", this.headWatermark)) : collectionRef);
      let watermark = this.headWatermark;
      const next = new Map(this.heads);
      for (const item of result.docs) {
        const data = item.data();
        if (item.metadata?.hasPendingWrites || data.protocol !== 2 || data.epoch !== this.epoch || !(data.updatedAt instanceof Timestamp)) throw new Error("Invalid sync head checkpoint");
        if (!watermark || data.updatedAt.seconds > watermark.seconds || (data.updatedAt.seconds === watermark.seconds && data.updatedAt.nanoseconds > watermark.nanoseconds)) watermark = data.updatedAt;
        next.set(item.id, data as SyncHead);
      }
      // Publish the cursor and its complete index together, only after success.
      this.heads = next; this.headWatermark = watermark;
      if (watermark) await writeSyncCache(this.cacheKey, {version: 1, heads: [...next], seconds: watermark.seconds, nanoseconds: watermark.nanoseconds});
      return [...next].map(([objectId, head]) => ({objectId, head}));
    })().finally(() => {this.headPull = null;});
    return this.headPull;
  }

  async stage(objectId: string, revision: string, encrypted: EncryptedObject): Promise<void> {
    safeID(objectId); safeID(revision);
    if (encrypted.contentType !== "application/vnd.boxie.sync-v2+json" || encrypted.epoch !== this.epoch || encrypted.ciphertext.length > 2_800_000) throw new Error("Invalid revision envelope");
    const path = `${this.path}/syncObjects/${objectId}/revisions/${revision}`;
    const chunks = encrypted.ciphertext.match(/.{1,350000}/g) ?? [];
    if (!chunks.length) throw new Error("Empty revision");
    // The revision path is unique and immutable. No writer cleans up another
    // revision's chunks; interrupted staging leaves the current head untouched.
    for (const [index, ciphertext] of chunks.entries()) {
      const ref = doc(this.db, `${path}/chunks/${String(index).padStart(4, "0")}`);
      const value = {protocol: 2, epoch: this.epoch, index, ciphertext};
      await runTransaction(this.db, async tx => {
        const old = await tx.get(ref);
        if (old.exists()) {
          if (old.get("ciphertext") !== ciphertext || old.get("epoch") !== this.epoch || old.get("index") !== index) throw new SyncWriteConflict("Immutable chunk collision");
        } else tx.set(ref, value);
      });
    }
    const {ciphertext: _ciphertext, createdAt: _createdAt, ...envelope} = encrypted;
    const value = {protocol: 2, epoch: this.epoch, envelope, chunkCount: chunks.length, ciphertextSize: encrypted.ciphertext.length};
    const ref = doc(this.db, path);
    await runTransaction(this.db, async tx => {
      const old = await tx.get(ref);
      if (old.exists()) {
        if (canonical(old.data()) !== canonical(value)) throw new SyncWriteConflict("Immutable manifest collision");
      } else tx.set(ref, value);
    });
  }
  async read(objectId: string, revision: string): Promise<EncryptedObject> {
    const path = `${this.path}/syncObjects/${safeID(objectId)}/revisions/${safeID(revision)}`;
    const result = await this.immutable(path);
    if (!result.exists() || result.get("epoch") !== this.epoch) throw new Error("Revision unavailable");
    const count = result.get("chunkCount") as number;
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Invalid revision chunk count");
    let ciphertext = "";
    for (let index = 0; index < count; index++) {
      const chunk = await this.immutable(`${path}/chunks/${String(index).padStart(4, "0")}`);
      if (!chunk.exists() || chunk.get("epoch") !== this.epoch || chunk.get("index") !== index || typeof chunk.get("ciphertext") !== "string") throw new Error("Incomplete revision");
      ciphertext += chunk.get("ciphertext");
    }
    if (ciphertext.length !== result.get("ciphertextSize")) throw new Error("Invalid revision length");
    return {...result.get("envelope"), ciphertext} as EncryptedObject;
  }
  async publish(objectId: string, next: Omit<SyncHead, "protocol" | "epoch" | "sequence">): Promise<void> {
    const ref = doc(this.db, `${this.path}/syncHeads/${safeID(objectId)}`);
    try { await runTransaction(this.db, async tx => {
      const old = await tx.get(ref);
      if (old.exists() && old.get("revision") === next.revision) {
        for (const key of ["kind", "baseRevision", "stream", "fence", "owner"] as const) {
          if (old.get(key) !== next[key]) throw new SyncWriteConflict("Revision publication identity changed");
        }
        return;
      }
      if ((old.exists() ? old.get("revision") : null) !== next.baseRevision) throw new SyncWriteConflict("State changed on another device");
      tx.set(ref, {...next, protocol: 2, epoch: this.epoch, sequence: old.exists() ? old.get("sequence") + 1 : 1, updatedAt: serverTimestamp()});
    }); } catch (error) {
      // Firestore rules can reject a stale-base write before the SDK reports a
      // transaction conflict. Confirm a changed head; do not retry permission
      // errors against an unchanged head or bypass the rules.
      const current = await this.head(objectId);
      if (current && current.revision !== next.baseRevision && current.epoch === this.epoch) throw new SyncWriteConflict("State changed on another device");
      throw error;
    }
  }
}
