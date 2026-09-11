import type { EncryptedCanonicalRecord } from "./encrypted-canonical-repository";

export interface PendingCanonicalReplication extends EncryptedCanonicalRecord {
  replicaRevision: string;
}

export interface CanonicalReplicationQueue {
  enqueueUnreplicated(): Promise<void>;
  listPending(limit?: number): Promise<PendingCanonicalReplication[]>;
  markReplicated(objectId: string, replicaRevision: string): Promise<void>;
  pendingCount(): Promise<number>;
}

export interface CanonicalCloudRepository {
  put(record: PendingCanonicalReplication): Promise<void>;
  get(objectId: string): Promise<EncryptedCanonicalRecord | null>;
  list(): Promise<EncryptedCanonicalRecord[]>;
  delete(objectId: string): Promise<void>;
}

export interface CanonicalReplicationResult {
  attempted: number;
  uploaded: number;
  remaining: number;
}

/**
 * Drains the durable local outbox one object at a time. The queue acknowledges
 * the exact encrypted revision that reached Firestore, so a concurrent local
 * rewrite cannot be accidentally marked as uploaded.
 */
export class CanonicalCloudReplicator {
  private active: Promise<CanonicalReplicationResult> | null = null;

  constructor(
    private readonly queue: CanonicalReplicationQueue,
    private readonly cloud: CanonicalCloudRepository,
    private readonly batchLimit = 100
  ) {}

  drain(): Promise<CanonicalReplicationResult> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  pendingCount(): Promise<number> {
    return this.queue.pendingCount();
  }

  private async run(): Promise<CanonicalReplicationResult> {
    await this.queue.enqueueUnreplicated();
    let attempted = 0;
    let uploaded = 0;
    const maximumObjectsPerDrain = 5_000;
    while (attempted < maximumObjectsPerDrain) {
      const pending = await this.queue.listPending(
        Math.min(this.batchLimit, maximumObjectsPerDrain - attempted)
      );
      if (pending.length === 0) break;
      for (const record of pending) {
        attempted += 1;
        await this.cloud.put(record);
        await this.queue.markReplicated(record.objectId, record.replicaRevision);
        uploaded += 1;
      }
    }
    return {
      attempted,
      uploaded,
      remaining: await this.queue.pendingCount()
    };
  }
}

export class MemoryCanonicalReplicationQueue implements CanonicalReplicationQueue {
  private readonly pending = new Map<string, PendingCanonicalReplication>();

  constructor(records: EncryptedCanonicalRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: EncryptedCanonicalRecord): void {
    this.pending.set(record.objectId, {
      ...structuredClone(record),
      replicaRevision: replicaRevision(record)
    });
  }

  async enqueueUnreplicated(): Promise<void> {}

  async listPending(limit = 100): Promise<PendingCanonicalReplication[]> {
    return [...this.pending.values()].slice(0, limit).map((record) => structuredClone(record));
  }

  async markReplicated(objectId: string, revision: string): Promise<void> {
    if (this.pending.get(objectId)?.replicaRevision === revision) {
      this.pending.delete(objectId);
    }
  }

  async pendingCount(): Promise<number> {
    return this.pending.size;
  }
}

export function replicaRevision(record: EncryptedCanonicalRecord): string {
  return `${record.encrypted.nonce}.${record.encrypted.wrappedKeyNonce}`;
}
