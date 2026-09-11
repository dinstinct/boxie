import type { EncryptedObject } from "../vault-spike/types";

export interface EncryptedObjectRecord {
  objectId: string;
  encrypted: EncryptedObject;
}

export interface EncryptedObjectRepository {
  put(record: EncryptedObjectRecord): Promise<void>;
  get(objectId: string): Promise<EncryptedObjectRecord | null>;
  list(): Promise<EncryptedObjectRecord[]>;
  delete(objectId: string): Promise<void>;
}

export class MemoryEncryptedObjectRepository implements EncryptedObjectRepository {
  private readonly records = new Map<string, EncryptedObject>();

  async put(record: EncryptedObjectRecord): Promise<void> {
    this.records.set(record.objectId, structuredClone(record.encrypted));
  }

  async get(objectId: string): Promise<EncryptedObjectRecord | null> {
    const encrypted = this.records.get(objectId);
    return encrypted
      ? { objectId, encrypted: structuredClone(encrypted) }
      : null;
  }

  async list(): Promise<EncryptedObjectRecord[]> {
    return [...this.records.entries()].map(([objectId, encrypted]) => ({
      objectId,
      encrypted: structuredClone(encrypted)
    }));
  }

  async delete(objectId: string): Promise<void> {
    this.records.delete(objectId);
  }
}
