import {describe, expect, it} from "vitest";
import {migrateOrganizations, type LegacyOrganizationSnapshot} from "./sync-v2-migration";
import type {Organization} from "../../contracts/sync/protocol";

function fixture() {
  const states = new Map<string, Organization>();
  const snapshot: LegacyOrganizationSnapshot = {vaultId: "vault", epoch: 1, mailboxObjectId: "mailbox", revision: "r1",
    preferences: {hidden: {moderation: "junk", locallyReadMessageIds: ["m1"]}}};
  const input = {vaultId: "vault", epoch: 1, deviceId: "mac", conversationIds: ["visible"],
    store: {async rollout() {return {phase: "frozen" as const, migrationOwner: "mac"};}},
    async readLegacy() {return structuredClone(snapshot);},
    repository: {async initialize(target: string, values: Record<string, unknown>) {
      if (!states.has(target)) states.set(target, {target, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {revision: "seed", value}])), receipts: {}});
      return {head: null, state: states.get(target)!};
    }}};
  return {input, states, snapshot};
}
describe("frozen organization migration", () => {
  it("includes hidden preferences and empty visible conversations, and can resume", async () => {
    const f = fixture();
    expect(await migrateOrganizations(f.input)).toEqual({targets: 2, legacyRevision: "r1"});
    expect(f.states.get("hidden")!.fields.moderation!.value).toBe("junk");
    expect(await migrateOrganizations(f.input)).toEqual({targets: 2, legacyRevision: "r1"});
  });
  it("refuses the wrong migration owner before writing", async () => {
    const f = fixture();
    await expect(migrateOrganizations({...f.input, deviceId: "phone"})).rejects.toThrow("own the frozen");
    expect(f.states.size).toBe(0);
  });
  it("preserves a conflicting existing organization and stops", async () => {
    const f = fixture();
    f.states.set("hidden", {target: "hidden", fields: {moderation: {revision: "edit", value: "normal"}}, receipts: {}});
    await expect(migrateOrganizations(f.input)).rejects.toThrow("without overwriting");
    expect(f.states.get("hidden")!.fields.moderation!.value).toBe("normal");
  });
  it("detects changes to the legacy snapshot rather than claiming migration complete", async () => {
    const f = fixture(); let reads = 0;
    f.input.readLegacy = async () => ({...f.snapshot, revision: ++reads === 1 ? "r1" : "r2"});
    await expect(migrateOrganizations(f.input)).rejects.toThrow("changed during migration");
  });
});
