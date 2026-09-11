import {readSyncCache, writeSyncCache} from './sync-read-cache';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type DocumentReference
} from "firebase/firestore";
import type { FirebaseSpikeClient } from "../vault-spike/firebase-client";
import type { EncryptedObject } from "../vault-spike/types";
import type {
  CanonicalCloudRepository,
  PendingCanonicalReplication
} from "./canonical-cloud-replication";
import { replicaRevision } from "./canonical-cloud-replication";
import type {
  CanonicalObjectKind,
  EncryptedCanonicalRecord
} from "./encrypted-canonical-repository";

export const MAX_INLINE_CIPHERTEXT_CHARS = 450_000;
export const MAX_CHUNK_CIPHERTEXT_CHARS = 350_000;
export const MAX_CANONICAL_CHUNKS = 64;

export interface CanonicalReplicaManifest {
  schemaVersion: 1;
  epoch: number;
  recordKind: CanonicalObjectKind;
  accountScopeId: string;
  algorithm: "AES-256-GCM";
  contentType: EncryptedObject["contentType"];
  nonce: string;
  wrappedKeyNonce: string;
  wrappedKey: string;
  replicaRevision: string;
  storage: "inline" | "chunked";
  state: "uploading" | "complete";
  ciphertextSize: number;
  chunkCount: number;
  ciphertext?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CanonicalReplicaChunk {
  schemaVersion: 1;
  epoch: number;
  replicaRevision: string;
  index: number;
  ciphertext: string;
  ciphertextSize: number;
  updatedAt?: unknown;
}

export interface CanonicalReplicaPlan {
  manifest: Omit<CanonicalReplicaManifest, "state" | "createdAt" | "updatedAt">;
  chunks: CanonicalReplicaChunk[];
}

export interface CanonicalReplicaDocumentStore {
  getManifest(objectId: string): Promise<CanonicalReplicaManifest | null>;
  putManifest(objectId: string, manifest: CanonicalReplicaManifest): Promise<void>;
  getChunk(objectId: string, index: number): Promise<CanonicalReplicaChunk | null>;
  putChunk(objectId: string, chunk: CanonicalReplicaChunk): Promise<void>;
  deleteChunk(objectId: string, index: number): Promise<void>;
  listManifests(): Promise<Array<{ objectId: string; manifest: CanonicalReplicaManifest }>>;
  deleteManifest(objectId: string): Promise<void>;
}

export function planCanonicalReplica(
  record: PendingCanonicalReplication
): CanonicalReplicaPlan {
  assertReplicableRecord(record);
  const ciphertext = record.encrypted.ciphertext;
  const chunks = ciphertext.length <= MAX_INLINE_CIPHERTEXT_CHARS
    ? []
    : splitCiphertext(ciphertext).map((value, index) => ({
        schemaVersion: 1 as const,
        epoch: record.encrypted.epoch,
        replicaRevision: record.replicaRevision,
        index,
        ciphertext: value,
        ciphertextSize: value.length
      }));
  return {
    manifest: {
      schemaVersion: 1,
      epoch: record.encrypted.epoch,
      recordKind: record.kind,
      accountScopeId: record.accountScopeId,
      algorithm: record.encrypted.algorithm,
      contentType: record.encrypted.contentType,
      nonce: record.encrypted.nonce,
      wrappedKeyNonce: record.encrypted.wrappedKeyNonce,
      wrappedKey: record.encrypted.wrappedKey,
      replicaRevision: record.replicaRevision,
      storage: chunks.length === 0 ? "inline" : "chunked",
      ciphertextSize: ciphertext.length,
      chunkCount: chunks.length,
      ...(chunks.length === 0 ? { ciphertext } : {})
    },
    chunks
  };
}

export function assembleCanonicalReplica(options: {
  objectId: string;
  manifest: CanonicalReplicaManifest;
  chunks: CanonicalReplicaChunk[];
}): EncryptedCanonicalRecord {
  const { manifest } = options;
  if (manifest.state !== "complete") {
    throw new Error("The encrypted cloud object is not complete yet.");
  }
  const ciphertext = manifest.storage === "inline"
    ? manifest.ciphertext
    : [...options.chunks]
        .sort((left, right) => left.index - right.index)
        .map((chunk, index) => {
          if (
            chunk.index !== index ||
            chunk.replicaRevision !== manifest.replicaRevision ||
            chunk.epoch !== manifest.epoch ||
            chunk.ciphertextSize !== chunk.ciphertext.length
          ) {
            throw new Error("An encrypted cloud chunk does not match its manifest.");
          }
          return chunk.ciphertext;
        })
        .join("");
  if (
    typeof ciphertext !== "string" ||
    options.chunks.length !== manifest.chunkCount ||
    ciphertext.length !== manifest.ciphertextSize
  ) {
    throw new Error("The encrypted cloud object is incomplete or has an invalid size.");
  }
  return {
    objectId: options.objectId,
    accountScopeId: manifest.accountScopeId,
    kind: manifest.recordKind,
    encrypted: {
      schemaVersion: 1,
      epoch: manifest.epoch,
      algorithm: manifest.algorithm,
      contentType: manifest.contentType,
      nonce: manifest.nonce,
      ciphertext,
      wrappedKeyNonce: manifest.wrappedKeyNonce,
      wrappedKey: manifest.wrappedKey
    }
  };
}

export class ChunkedCanonicalCloudRepository implements CanonicalCloudRepository {
  constructor(private readonly documents: CanonicalReplicaDocumentStore, private readonly frozenCache?: {key: string; epoch: number}) {}

  async put(record: PendingCanonicalReplication): Promise<void> {
    const plan = planCanonicalReplica(record);
    const previous = await this.documents.getManifest(record.objectId);
    const createdAt = previous?.createdAt;

    if (plan.manifest.storage === "chunked") {
      await this.documents.putManifest(record.objectId, {
        ...plan.manifest,
        state: "uploading",
        createdAt
      });
      for (const chunk of plan.chunks) {
        await this.documents.putChunk(record.objectId, chunk);
      }
    }

    await this.documents.putManifest(record.objectId, {
      ...plan.manifest,
      state: "complete",
      createdAt
    });

    const staleChunkCount = previous?.chunkCount ?? 0;
    for (let index = plan.chunks.length; index < staleChunkCount; index += 1) {
      await this.documents.deleteChunk(record.objectId, index);
    }
  }

  async get(objectId: string): Promise<EncryptedCanonicalRecord | null> {
    const manifest = await this.documents.getManifest(objectId);
    if (!manifest || manifest.state !== "complete") return null;
    const chunks = manifest.storage === "chunked"
      ? await Promise.all(Array.from(
          { length: manifest.chunkCount },
          (_, index) => this.documents.getChunk(objectId, index)
        ))
      : [];
    if (chunks.some((chunk) => chunk === null)) {
      throw new Error("The encrypted cloud object is missing one or more chunks.");
    }
    return assembleCanonicalReplica({
      objectId,
      manifest,
      chunks: chunks as CanonicalReplicaChunk[]
    });
  }

  async list(): Promise<EncryptedCanonicalRecord[]> {
    if (this.frozenCache) {
      const cached = await readSyncCache<{version: number; records: EncryptedCanonicalRecord[]}>(this.frozenCache.key);
      if (cached?.version === 1 && Array.isArray(cached.records) && cached.records.every(record => record.encrypted?.epoch === this.frozenCache!.epoch)) return cached.records;
    }
    const manifests = await this.documents.listManifests();
    const records: EncryptedCanonicalRecord[] = [];
    for (const item of manifests) {
      if (item.manifest.state !== "complete") continue;
      const chunks = item.manifest.storage === 'chunked' ? await Promise.all(Array.from({length: item.manifest.chunkCount}, (_, index) => this.documents.getChunk(item.objectId, index))) : [];
      if (chunks.some(chunk => chunk === null)) throw new Error('The encrypted cloud object is missing one or more chunks.');
      const record = assembleCanonicalReplica({objectId: item.objectId, manifest: item.manifest, chunks: chunks as CanonicalReplicaChunk[]});
      if (record) records.push(record);
    }
    if (this.frozenCache) {
      if (!records.every(record => record.encrypted.epoch === this.frozenCache!.epoch)) throw new Error('Frozen baseline epoch mismatch');
      await writeSyncCache(this.frozenCache.key, {version: 1, records});
    }
    return records;
  }

  async delete(objectId: string): Promise<void> {
    const manifest = await this.documents.getManifest(objectId);
    for (let index = 0; index < (manifest?.chunkCount ?? 0); index += 1) {
      await this.documents.deleteChunk(objectId, index);
    }
    await this.documents.deleteManifest(objectId);
  }
}

export class FirebaseCanonicalReplicaDocumentStore implements CanonicalReplicaDocumentStore {
  constructor(
    private readonly client: FirebaseSpikeClient,
    private readonly uid: string,
    private readonly vaultId: string
  ) {}

  async getManifest(objectId: string): Promise<CanonicalReplicaManifest | null> {
    const snapshot = await getDoc(this.manifestRef(objectId));
    return snapshot.exists() ? snapshot.data() as CanonicalReplicaManifest : null;
  }

  async putManifest(objectId: string, manifest: CanonicalReplicaManifest): Promise<void> {
    await setDoc(this.manifestRef(objectId), {
      ...withoutUndefined(manifest),
      createdAt: manifest.createdAt ?? serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  async getChunk(objectId: string, index: number): Promise<CanonicalReplicaChunk | null> {
    const snapshot = await getDoc(this.chunkRef(objectId, index));
    return snapshot.exists() ? snapshot.data() as CanonicalReplicaChunk : null;
  }

  async putChunk(objectId: string, chunk: CanonicalReplicaChunk): Promise<void> {
    await setDoc(this.chunkRef(objectId, chunk.index), {
      ...chunk,
      updatedAt: serverTimestamp()
    });
  }

  async deleteChunk(objectId: string, index: number): Promise<void> {
    await deleteDoc(this.chunkRef(objectId, index));
  }

  async listManifests(): Promise<Array<{ objectId: string; manifest: CanonicalReplicaManifest }>> {
    const snapshot = await getDocs(collection(
      this.client.db,
      "boxie",
      this.uid,
      "vaults",
      this.vaultId,
      "canonical"
    ));
    return snapshot.docs.map((item) => ({
      objectId: item.id,
      manifest: item.data() as CanonicalReplicaManifest
    }));
  }

  async deleteManifest(objectId: string): Promise<void> {
    await deleteDoc(this.manifestRef(objectId));
  }

  private manifestRef(objectId: string): DocumentReference<DocumentData> {
    return doc(
      this.client.db,
      "boxie",
      this.uid,
      "vaults",
      this.vaultId,
      "canonical",
      objectId
    );
  }

  private chunkRef(objectId: string, index: number): DocumentReference<DocumentData> {
    return doc(this.manifestRef(objectId), "chunks", chunkDocumentId(index));
  }
}

export class MemoryCanonicalReplicaDocumentStore implements CanonicalReplicaDocumentStore {
  readonly manifests = new Map<string, CanonicalReplicaManifest>();
  readonly chunks = new Map<string, CanonicalReplicaChunk>();

  async getManifest(objectId: string): Promise<CanonicalReplicaManifest | null> {
    const value = this.manifests.get(objectId);
    return value ? structuredClone(value) : null;
  }

  async putManifest(objectId: string, manifest: CanonicalReplicaManifest): Promise<void> {
    this.manifests.set(objectId, structuredClone(manifest));
  }

  async getChunk(objectId: string, index: number): Promise<CanonicalReplicaChunk | null> {
    const value = this.chunks.get(`${objectId}:${index}`);
    return value ? structuredClone(value) : null;
  }

  async putChunk(objectId: string, chunk: CanonicalReplicaChunk): Promise<void> {
    this.chunks.set(`${objectId}:${chunk.index}`, structuredClone(chunk));
  }

  async deleteChunk(objectId: string, index: number): Promise<void> {
    this.chunks.delete(`${objectId}:${index}`);
  }

  async listManifests(): Promise<Array<{ objectId: string; manifest: CanonicalReplicaManifest }>> {
    return [...this.manifests.entries()].map(([objectId, manifest]) => ({
      objectId,
      manifest: structuredClone(manifest)
    }));
  }

  async deleteManifest(objectId: string): Promise<void> {
    this.manifests.delete(objectId);
  }
}

function splitCiphertext(ciphertext: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < ciphertext.length; start += MAX_CHUNK_CIPHERTEXT_CHARS) {
    chunks.push(ciphertext.slice(start, start + MAX_CHUNK_CIPHERTEXT_CHARS));
  }
  if (chunks.length > MAX_CANONICAL_CHUNKS) {
    throw new Error("This encrypted email is too large for Boxie's Firestore-only replica.");
  }
  return chunks;
}

function assertReplicableRecord(record: PendingCanonicalReplication): void {
  const opaqueId = /^obj_[A-Za-z0-9_-]{43}$/u;
  if (!opaqueId.test(record.objectId) || !opaqueId.test(record.accountScopeId)) {
    throw new Error("A canonical cloud record must use vault-keyed opaque identifiers.");
  }
  const expectedContentType = record.kind === "mailbox"
    ? "application/vnd.boxie.canonical-mailbox+json"
    : "application/vnd.boxie.canonical-message+json";
  if (
    record.encrypted.contentType !== expectedContentType ||
    record.encrypted.epoch < 1 ||
    record.replicaRevision !== replicaRevision(record) ||
    record.encrypted.ciphertext.length === 0
  ) {
    throw new Error("A canonical cloud record has invalid authenticated metadata.");
  }
}

function chunkDocumentId(index: number): string {
  return String(index).padStart(4, "0");
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
