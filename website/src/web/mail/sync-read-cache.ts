import {openDB} from 'idb';
// Only encrypted cloud envelopes or sync metadata belong here, never decrypted mail.
// A single value contains the complete snapshot and cursor so eviction is a miss.
let opened: ReturnType<typeof openDB> | undefined;
function database() {return opened ??= openDB('boxie-sync-read-cache-v1', 1, {upgrade(db) {db.createObjectStore('snapshots');}}).catch(error => {opened = undefined; throw error;});}
export async function readSyncCache<T>(key: string): Promise<T | null> {
  try {const db = await database(); return (await db.get('snapshots', key)) ?? null;} catch {return null;}
}
export async function writeSyncCache(key: string, value: unknown): Promise<void> {
  try {const db = await database(); await db.put('snapshots', value, key);} catch { /* Cache failure cannot fail sync. */ }
}

export async function deleteSyncCacheForVault(uid: string, vaultId: string): Promise<void> {
  try {
    const db = await database(); const keys = await db.getAllKeys('snapshots');
    const tx = db.transaction('snapshots', 'readwrite');
    for (const key of keys) if (typeof key === 'string' && key.includes(`/boxie/${uid}/vaults/${vaultId}/`)) await tx.store.delete(key);
    await tx.done;
  } catch { /* Disposable cache; account/epoch isolation still applies. */ }
}
