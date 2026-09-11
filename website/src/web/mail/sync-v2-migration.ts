import {canonical} from "../../contracts/sync/protocol";
import type {BrowserConversationPreference} from "./canonical-types";
import {preferenceFromOrganization} from "./organization-actions";
import type {SyncedOrganization} from "./sync-v2-organization";
import type {SyncV2Store} from "./sync-v2-store";

export interface LegacyOrganizationSnapshot {
  vaultId: string;
  epoch: number;
  mailboxObjectId: string;
  revision: string;
  preferences: Record<string, BrowserConversationPreference>;
}
/** Copy after the server cutoff, never erase the legacy snapshot. This phase
 * does not activate v2: source/cursor migration and every installed client's
 * pending queue must be handled before the separate rollout transition. */
export async function migrateOrganizations(input: {
  store: Pick<SyncV2Store, "rollout">;
  repository: Pick<SyncedOrganization, "initialize">;
  vaultId: string;
  epoch: number;
  deviceId: string;
  conversationIds: string[];
  readLegacy: () => Promise<LegacyOrganizationSnapshot>;
}): Promise<{targets: number; legacyRevision: string}> {
  const requireFrozen = async () => {
    const control = await input.store.rollout();
    if (control?.phase !== "frozen" || control.migrationOwner !== input.deviceId) throw new Error("Migration requires this device to own the frozen rollout");
  };
  await requireFrozen();
  const snapshot = await input.readLegacy();
  if (snapshot.vaultId !== input.vaultId || snapshot.epoch !== input.epoch || !snapshot.revision) throw new Error("Legacy migration identity mismatch");
  const targets = [...new Set([...input.conversationIds, ...Object.keys(snapshot.preferences)])].sort();
  // Include preference-only conversations, such as hidden Junk/Trash. Dropping
  // them because they are absent from the visible chat list loses user intent.
  for (const target of targets) {
    const values = snapshot.preferences[target] ?? {};
    const result = await input.repository.initialize(target, values as Record<string, unknown>,
      canonical({mailbox: snapshot.mailboxObjectId, revision: snapshot.revision}));
    if (canonical(preferenceFromOrganization(result.state)) !== canonical(values)) {
      throw new Error("Existing organization differs from the frozen snapshot; migration stopped without overwriting it");
    }
  }
  await requireFrozen();
  const current = await input.readLegacy();
  if (canonical(current) !== canonical(snapshot)) throw new Error("Legacy snapshot changed during migration");
  return {targets: targets.length, legacyRevision: snapshot.revision};
}
