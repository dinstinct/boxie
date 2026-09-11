import {describe, expect, it} from "vitest";
import {webcrypto} from "node:crypto";
import {SyncedOrganization, revisionAAD, type OrganizationTransport} from "./sync-v2-organization";
import {SyncWriteConflict, type SyncHead} from "./sync-v2-store";
import type {EncryptedObject} from "../vault-spike/types";
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", {value: webcrypto});
class Transport implements OrganizationTransport {
  heads = new Map<string, SyncHead>();
  revisions = new Map<string, EncryptedObject>();
  writes = 0;
  async head(id: string) { return structuredClone(this.heads.get(id) ?? null); }
  async read(id: string, revision: string) { return structuredClone(this.revisions.get(revisionAAD(id, revision))!); }
  async stage(id: string, revision: string, value: EncryptedObject) { this.revisions.set(revisionAAD(id, revision), structuredClone(value)); }
  async publish(id: string, next: Omit<SyncHead, "protocol" | "epoch" | "sequence">) {
    const old = this.heads.get(id);
    if ((old?.revision ?? null) !== next.baseRevision) throw new SyncWriteConflict("changed");
    this.heads.set(id, {...next, protocol: 2, epoch: 1, sequence: (old?.sequence ?? 0) + 1});
    this.writes++;
  }
}
const vault = {vaultId: "vault", epoch: 1, vaultKey: new Uint8Array(32).fill(7), deviceId: "mac"};
const op = (id: string, field: string, value: string) => ({id, target: "conversation", changes: {[field]: {expected: null, value}}});
describe("encrypted v2 organization repository", () => {
  it("merges simultaneous independent device edits after conditional conflict", async () => {
    const transport = new Transport();
    const mac = new SyncedOrganization(transport, vault), android = new SyncedOrganization(transport, {...vault, deviceId: "android"});
    await Promise.all([mac.apply(op("rename", "name", "Alice")), android.apply(op("accept", "admission", "accepted"))]);
    const state = (await mac.load("conversation")).state;
    expect(state.fields.name?.value).toBe("Alice");
    expect(state.fields.admission?.value).toBe("accepted");
    expect(JSON.stringify([...transport.revisions.values()])).not.toContain("Alice");
    const count = transport.writes;
    await android.apply(op("accept", "admission", "accepted"));
    await mac.load("conversation");
    expect(transport.writes).toBe(count);
  });
  it("seeds legacy preferences once without overwriting later edits or replaying migration", async () => {
    const transport = new Transport(), repo = new SyncedOrganization(transport, vault);
    const first = await repo.initialize("conversation", {customName: "Legacy name", admission: "accepted"}, "legacy-revision");
    const result = await repo.apply({id: "later", target: "conversation", changes: {customName: {expected: first.state.fields.customName!.revision, value: "New name"}}});
    expect(result.status).toBe("applied");
    const before = transport.writes;
    const repeated = await repo.initialize("conversation", {customName: "Legacy name", admission: "accepted"}, "legacy-revision");
    expect(repeated.state.fields.customName!.value).toBe("New name");
    expect(transport.writes).toBe(before);
    expect(JSON.stringify([...transport.revisions.values()])).not.toContain("Legacy name");
  });
  it("bootstraps an empty conversation safely under concurrent creators", async () => {
    const transport = new Transport(), repo = new SyncedOrganization(transport, vault);
    const results = await Promise.all([repo.initialize("conversation", {}, "new"), repo.initialize("conversation", {}, "new")]);
    expect(results[0]!.head!.revision).toBe(results[1]!.head!.revision);
    expect(transport.writes).toBe(1);
  });
  it("returns a conflict for stale same-field changes and retains the winning value", async () => {
    const transport = new Transport(), repo = new SyncedOrganization(transport, vault);
    await repo.apply(op("one", "name", "Alice"));
    expect((await repo.apply(op("two", "name", "Bob"))).status).toBe("conflict");
    expect((await repo.load("conversation")).state.fields.name?.value).toBe("Alice");
  });
  it("rejects ciphertext transplanted to another revision", async () => {
    const transport = new Transport(), repo = new SyncedOrganization(transport, vault);
    await repo.apply(op("one", "name", "Alice"));
    const head = transport.heads.get("conversation")!;
    transport.revisions.set(revisionAAD("conversation", "forged"), await transport.read("conversation", head.revision));
    transport.heads.set("conversation", {...head, revision: "forged"});
    await expect(repo.load("conversation")).rejects.toThrow();
  });
});
