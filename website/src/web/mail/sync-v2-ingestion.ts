import {canonical} from "../../contracts/sync/protocol";
import {decryptJsonObject, encryptJsonObject} from "../vault-spike/crypto";
import {revisionAAD, type OrganizationTransport} from "./sync-v2-organization";
import {SyncWriteConflict, type IngestionLease, type SyncHead} from "./sync-v2-store";

interface IngestionTransport extends OrganizationTransport {
  acquire(stream: string, owner: string): Promise<IngestionLease>;
  renew(lease: IngestionLease): Promise<IngestionLease>;
}
type Vault = {vaultId: string; epoch: number; vaultKey: Uint8Array; deviceId: string};
type Source = {objectId: string; value: unknown};
const contentType = "application/vnd.boxie.sync-v2+json";
/** A page is the recovery boundary. Both intermediate next links and final delta
 * links are encrypted. No checkpoint is published until every source in that
 * page is acknowledged. A failed page is fetched again from the old checkpoint;
 * already durable, identical source values are not republished.
 *
 * Source IDs must identify stream membership (not a shared cross-folder slot).
 * Provider normalization, T0 filtering and reset reconciliation are caller duties.
 */
export class SyncedIngestion {
  constructor(private readonly transport: IngestionTransport, private readonly vault: Vault) {}
  acquire(stream: string) {return this.transport.acquire(stream, this.vault.deviceId);}
  private validate(head: SyncHead, kind: "source" | "checkpoint", stream: string) {
    if (head.protocol !== 2 || head.epoch !== this.vault.epoch || head.kind !== kind || head.stream !== stream) {
      throw new Error("Ingestion head identity mismatch");
    }
  }
  private async read(objectId: string, head: SyncHead): Promise<unknown> {
    const encrypted = await this.transport.read(objectId, head.revision);
    if (encrypted.epoch !== this.vault.epoch) throw new Error("Old ingestion epoch");
    const payload = await decryptJsonObject<{protocol: number; kind: string; stream: string; value: unknown}>({
      ...this.vault, objectId: revisionAAD(objectId, head.revision), encrypted, expectedContentType: contentType
    });
    if (payload.protocol !== 2 || payload.kind !== head.kind || payload.stream !== head.stream) throw new Error("Ingestion payload identity mismatch");
    return payload.value;
  }
  async source(objectId: string, stream: string, suppliedHead?: SyncHead): Promise<{revision: string | null; value: unknown}> {
    const head = suppliedHead ?? await this.transport.head(objectId);
    if (!head) throw new Error("Source head disappeared");
    this.validate(head, "source", stream);
    return {revision: head.revision, value: await this.read(objectId, head)};
  }
  async checkpoint(objectId: string, stream: string): Promise<{revision: string | null; value: unknown}> {
    const head = await this.transport.head(objectId);
    if (!head) return {revision: null, value: null};
    this.validate(head, "checkpoint", stream);
    return {revision: head.revision, value: await this.read(objectId, head)};
  }
  private async put(objectId: string, kind: "source" | "checkpoint", value: unknown, base: SyncHead | null, lease: IngestionLease) {
    const revision = crypto.randomUUID();
    const encrypted = await encryptJsonObject({...this.vault, objectId: revisionAAD(objectId, revision), contentType,
      payload: {protocol: 2, kind, stream: lease.stream, value}});
    await this.transport.stage(objectId, revision, encrypted);
    await this.transport.publish(objectId, {kind, revision, baseRevision: base?.revision ?? null,
      stream: lease.stream, owner: lease.owner, fence: lease.fence});
    return revision;
  }
  async publishPage(input: {
    lease: IngestionLease; checkpointId: string; expectedCheckpoint: string | null;
    sources: Source[]; checkpoint: unknown;
  }): Promise<{lease: IngestionLease; revision: string}> {
    if (input.lease.owner !== this.vault.deviceId) throw new SyncWriteConflict("Wrong ingestion owner");
    if (input.sources.length > 5000) throw new Error("Ingestion page too large");
    const ids = new Set<string>([input.checkpointId]);
    revisionAAD(input.checkpointId, "validate");
    canonical(input.checkpoint);
    for (const source of input.sources) {
      revisionAAD(source.objectId, "validate"); canonical(source.value);
      if (ids.has(source.objectId)) throw new Error("Duplicate ingestion object");
      ids.add(source.objectId);
    }
    let lease = await this.transport.renew(input.lease);
    const checkpoint = await this.transport.head(input.checkpointId);
    if (checkpoint) this.validate(checkpoint, "checkpoint", lease.stream);
    if ((checkpoint?.revision ?? null) !== input.expectedCheckpoint) throw new SyncWriteConflict("Checkpoint changed; reload before fetching another page");
    for (const [index, source] of input.sources.entries()) {
      if (index > 0 && index % 20 === 0) lease = await this.transport.renew(lease);
      const head = await this.transport.head(source.objectId);
      if (head) {
        this.validate(head, "source", lease.stream);
        if (canonical(await this.read(source.objectId, head)) === canonical(source.value)) continue;
      }
      await this.put(source.objectId, "source", source.value, head, lease);
    }
    // Confirm this exact fence remains active after all dependency writes. Never
    // reacquire inside a page: takeover requires reloading the durable cursor.
    lease = await this.transport.renew(lease);
    const revision = await this.put(input.checkpointId, "checkpoint", input.checkpoint, checkpoint, lease);
    return {lease, revision};
  }
}
