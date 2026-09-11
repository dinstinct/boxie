import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  EncryptedObjectRecord,
  EncryptedObjectRepository
} from "./encrypted-object-repository";

interface PersistedEncryptedObject extends EncryptedObjectRecord {
  key: string;
  uid: string;
  vaultId: string;
  storedAt: number;
}

interface EncryptedReplicaDatabase extends DBSchema {
  objects: {
    key: string;
    value: PersistedEncryptedObject;
    indexes: {
      "by-vault": [string, string];
    };
  };
}

let databasePromise: Promise<IDBPDatabase<EncryptedReplicaDatabase>> | null = null;

function openReplicaDatabase(): Promise<IDBPDatabase<EncryptedReplicaDatabase>> {
  databasePromise ??= openDB<EncryptedReplicaDatabase>("boxie-encrypted-replica-v1", 1, {
    upgrade(database) {
      const objects = database.createObjectStore("objects", { keyPath: "key" });
      objects.createIndex("by-vault", ["uid", "vaultId"]);
    }
  });
  return databasePromise;
}

export async function deleteIndexedDbEncryptedObjectVault(
  uid: string,
  vaultId: string
): Promise<void> {
  const database = await openReplicaDatabase();
  const keys = await database.getAllKeysFromIndex("objects", "by-vault", [uid, vaultId]);
  const transaction = database.transaction("objects", "readwrite");
  await Promise.all([
    ...keys.map((key) => transaction.objectStore("objects").delete(key)),
    transaction.done
  ]);
}

export class IndexedDbEncryptedObjectRepository implements EncryptedObjectRepository {
  constructor(
    private readonly uid: string,
    private readonly vaultId: string
  ) {}

  async put(record: EncryptedObjectRecord): Promise<void> {
    await (await openReplicaDatabase()).put("objects", {
      key: this.key(record.objectId),
      uid: this.uid,
      vaultId: this.vaultId,
      objectId: record.objectId,
      encrypted: record.encrypted,
      storedAt: Date.now()
    });
  }

  async get(objectId: string): Promise<EncryptedObjectRecord | null> {
    const value = await (await openReplicaDatabase()).get("objects", this.key(objectId));
    return value ? { objectId: value.objectId, encrypted: value.encrypted } : null;
  }

  async list(): Promise<EncryptedObjectRecord[]> {
    const values = await (await openReplicaDatabase()).getAllFromIndex(
      "objects",
      "by-vault",
      [this.uid, this.vaultId]
    );
    return values.map((value) => ({
      objectId: value.objectId,
      encrypted: value.encrypted
    }));
  }

  async delete(objectId: string): Promise<void> {
    await (await openReplicaDatabase()).delete("objects", this.key(objectId));
  }

  private key(objectId: string): string {
    return `${this.uid}:${this.vaultId}:${objectId}`;
  }
}
