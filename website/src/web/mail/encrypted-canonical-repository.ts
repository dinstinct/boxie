import {deleteSyncCacheForVault} from './sync-read-cache';
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { EncryptedObject } from "../vault-spike/types";
import {
  replicaRevision,
  type CanonicalReplicationQueue,
  type PendingCanonicalReplication
} from "./canonical-cloud-replication";

export type CanonicalObjectKind = "mailbox" | "message";

export interface EncryptedCanonicalRecord {
  objectId: string;
  accountScopeId: string;
  kind: CanonicalObjectKind;
  encrypted: EncryptedObject;
}

export interface EncryptedCanonicalRepository {
  get(objectId: string): Promise<EncryptedCanonicalRecord | null>;
  putMany(records: EncryptedCanonicalRecord[]): Promise<void>;
  list(accountScopeId: string, kind?: CanonicalObjectKind): Promise<EncryptedCanonicalRecord[]>;
  listAll(kind?: CanonicalObjectKind): Promise<EncryptedCanonicalRecord[]>;
  delete(objectId: string): Promise<void>;
}

interface PersistedCanonicalRecord extends EncryptedCanonicalRecord {
  key: string;
  uid: string;
  vaultId: string;
  storedAt: number;
  cloudRevision?: string | null;
}

interface PersistedCanonicalReplication extends PendingCanonicalReplication {
  key: string;
  uid: string;
  vaultId: string;
  enqueuedAt: number;
}

interface CanonicalDatabase extends DBSchema {
  objects: {
    key: string;
    value: PersistedCanonicalRecord;
    indexes: {
      "by-account": [string, string, string];
      "by-account-kind": [string, string, string, CanonicalObjectKind];
    };
  };
  replicationQueue: {
    key: string;
    value: PersistedCanonicalReplication;
    indexes: {
      "by-vault": [string, string];
    };
  };
}

let databasePromise: Promise<IDBPDatabase<CanonicalDatabase>> | null = null;

function canonicalDatabase(): Promise<IDBPDatabase<CanonicalDatabase>> {
  databasePromise ??= openDB<CanonicalDatabase>("boxie-encrypted-canonical-v1", 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const objects = database.createObjectStore("objects", { keyPath: "key" });
        objects.createIndex("by-account", ["uid", "vaultId", "accountScopeId"]);
        objects.createIndex("by-account-kind", ["uid", "vaultId", "accountScopeId", "kind"]);
      }
      if (oldVersion < 2) {
        const queue = database.createObjectStore("replicationQueue", { keyPath: "key" });
        queue.createIndex("by-vault", ["uid", "vaultId"]);
      }
    }
  });
  return databasePromise;
}

export async function deleteIndexedDbCanonicalVault(
  uid: string,
  vaultId: string
): Promise<void> {
  const database = await canonicalDatabase();
  await deleteSyncCacheForVault(uid, vaultId);
  const records = await database.getAll("objects");
  const queued = await database.getAll("replicationQueue");
  const transaction = database.transaction(["objects", "replicationQueue"], "readwrite");
  await Promise.all([
    ...records
      .filter((record) => record.uid === uid && record.vaultId === vaultId)
      .map((record) => transaction.objectStore("objects").delete(record.key)),
    ...queued
      .filter((record) => record.uid === uid && record.vaultId === vaultId)
      .map((record) => transaction.objectStore("replicationQueue").delete(record.key)),
    transaction.done
  ]);
}

export class IndexedDbEncryptedCanonicalRepository
implements EncryptedCanonicalRepository, CanonicalReplicationQueue {
  constructor(
    private readonly uid: string,
    private readonly vaultId: string
  ) {}

  async get(objectId: string): Promise<EncryptedCanonicalRecord | null> {
    const value = await (await canonicalDatabase()).get("objects", this.key(objectId));
    return value ? toPublicRecord(value) : null;
  }

  async putMany(records: EncryptedCanonicalRecord[]): Promise<void> {
    if (records.length === 0) return;
    const database = await canonicalDatabase();
    const transaction = database.transaction(["objects", "replicationQueue"], "readwrite");
    const objects = transaction.objectStore("objects");
    const queue = transaction.objectStore("replicationQueue");
    for (const record of records) {
      const key = this.key(record.objectId);
      const revision = replicaRevision(record);
      const existing = await objects.get(key);
      const alreadyReplicated = existing?.cloudRevision === revision;
      await objects.put({
        ...record,
        key,
        uid: this.uid,
        vaultId: this.vaultId,
        storedAt: Date.now(),
        cloudRevision: alreadyReplicated ? revision : existing?.cloudRevision ?? null
      });
      if (alreadyReplicated) {
        await queue.delete(key);
      } else {
        await queue.put({
          ...record,
          key,
          uid: this.uid,
          vaultId: this.vaultId,
          replicaRevision: revision,
          enqueuedAt: Date.now()
        });
      }
    }
    await transaction.done;
  }

  /**
   * Hydrates only objects missing on this device and records that the exact
   * encrypted revision already exists in Firestore. Existing local objects win;
   * cross-device conflict resolution is deliberately not guessed here.
   */
  async importReplicated(records: EncryptedCanonicalRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const database = await canonicalDatabase();
    const transaction = database.transaction(["objects", "replicationQueue"], "readwrite");
    const objects = transaction.objectStore("objects");
    const queue = transaction.objectStore("replicationQueue");
    let imported = 0;
    for (const record of records) {
      const key = this.key(record.objectId);
      if (await objects.get(key)) continue;
      const revision = replicaRevision(record);
      await objects.put({
        ...record,
        key,
        uid: this.uid,
        vaultId: this.vaultId,
        storedAt: Date.now(),
        cloudRevision: revision
      });
      await queue.delete(key);
      imported += 1;
    }
    await transaction.done;
    return imported;
  }

  async list(
    accountScopeId: string,
    kind?: CanonicalObjectKind
  ): Promise<EncryptedCanonicalRecord[]> {
    const database = await canonicalDatabase();
    const values = kind
      ? await database.getAllFromIndex(
          "objects",
          "by-account-kind",
          [this.uid, this.vaultId, accountScopeId, kind]
        )
      : await database.getAllFromIndex(
          "objects",
          "by-account",
          [this.uid, this.vaultId, accountScopeId]
        );
    return values.map(toPublicRecord);
  }

  async listAll(kind?: CanonicalObjectKind): Promise<EncryptedCanonicalRecord[]> {
    const values = await (await canonicalDatabase()).getAll("objects");
    return values
      .filter((value) =>
        value.uid === this.uid &&
        value.vaultId === this.vaultId &&
        (!kind || value.kind === kind)
      )
      .map(toPublicRecord);
  }

  async delete(objectId: string): Promise<void> {
    const database = await canonicalDatabase();
    const transaction = database.transaction(["objects", "replicationQueue"], "readwrite");
    await Promise.all([
      transaction.objectStore("objects").delete(this.key(objectId)),
      transaction.objectStore("replicationQueue").delete(this.key(objectId)),
      transaction.done
    ]);
  }

  async enqueueUnreplicated(): Promise<void> {
    const database = await canonicalDatabase();
    const values = await database.getAll("objects");
    const transaction = database.transaction("replicationQueue", "readwrite");
    for (const value of values) {
      if (value.uid !== this.uid || value.vaultId !== this.vaultId) continue;
      const record = toPublicRecord(value);
      const revision = replicaRevision(record);
      if (value.cloudRevision === revision) continue;
      await transaction.store.put({
        ...record,
        key: value.key,
        uid: this.uid,
        vaultId: this.vaultId,
        replicaRevision: revision,
        enqueuedAt: Date.now()
      });
    }
    await transaction.done;
  }

  async listPending(limit = 100): Promise<PendingCanonicalReplication[]> {
    const values = await (await canonicalDatabase()).getAllFromIndex(
      "replicationQueue",
      "by-vault",
      [this.uid, this.vaultId],
      limit
    );
    return values.map((value) => ({
      objectId: value.objectId,
      accountScopeId: value.accountScopeId,
      kind: value.kind,
      encrypted: value.encrypted,
      replicaRevision: value.replicaRevision
    }));
  }

  async markReplicated(objectId: string, revision: string): Promise<void> {
    const database = await canonicalDatabase();
    const key = this.key(objectId);
    const transaction = database.transaction(["objects", "replicationQueue"], "readwrite");
    const objects = transaction.objectStore("objects");
    const queue = transaction.objectStore("replicationQueue");
    const current = await objects.get(key);
    const pending = await queue.get(key);
    if (current && replicaRevision(toPublicRecord(current)) === revision) {
      await objects.put({ ...current, cloudRevision: revision });
    }
    if (pending?.replicaRevision === revision) {
      await queue.delete(key);
    }
    await transaction.done;
  }

  async pendingCount(): Promise<number> {
    return (await (await canonicalDatabase()).getAllKeysFromIndex(
      "replicationQueue",
      "by-vault",
      [this.uid, this.vaultId]
    )).length;
  }

  private key(objectId: string): string {
    return `${this.uid}:${this.vaultId}:${objectId}`;
  }
}

export class MemoryEncryptedCanonicalRepository implements EncryptedCanonicalRepository {
  private readonly values = new Map<string, EncryptedCanonicalRecord>();

  async get(objectId: string): Promise<EncryptedCanonicalRecord | null> {
    const value = this.values.get(objectId);
    return value ? structuredClone(value) : null;
  }

  async putMany(records: EncryptedCanonicalRecord[]): Promise<void> {
    for (const record of records) {
      this.values.set(record.objectId, structuredClone(record));
    }
  }

  async list(
    accountScopeId: string,
    kind?: CanonicalObjectKind
  ): Promise<EncryptedCanonicalRecord[]> {
    return [...this.values.values()]
      .filter((value) => value.accountScopeId === accountScopeId && (!kind || value.kind === kind))
      .map((value) => structuredClone(value));
  }

  async listAll(kind?: CanonicalObjectKind): Promise<EncryptedCanonicalRecord[]> {
    return [...this.values.values()]
      .filter((value) => !kind || value.kind === kind)
      .map((value) => structuredClone(value));
  }

  async delete(objectId: string): Promise<void> {
    this.values.delete(objectId);
  }
}

function toPublicRecord(value: PersistedCanonicalRecord): EncryptedCanonicalRecord {
  return {
    objectId: value.objectId,
    accountScopeId: value.accountScopeId,
    kind: value.kind,
    encrypted: value.encrypted
  };
}
