import type { CanonicalCloudRepository } from "./canonical-cloud-replication";
import type { EncryptedCanonicalRecord } from "./encrypted-canonical-repository";

export interface CanonicalReplicaHydrationTarget {
  importReplicated(records: EncryptedCanonicalRecord[]): Promise<number>;
}

/**
 * Pull every complete cloud envelope and let the local repository import only
 * records it does not already own. This must run even when a mailbox record is
 * present locally: a paired device may have an empty mailbox plus missing mail.
 */
export async function hydrateMissingCanonicalReplica(options: {
  local: CanonicalReplicaHydrationTarget;
  cloud: CanonicalCloudRepository;
}): Promise<{ discovered: number; imported: number }> {
  const records = await options.cloud.list();
  return {
    discovered: records.length,
    imported: await options.local.importReplicated(records)
  };
}
