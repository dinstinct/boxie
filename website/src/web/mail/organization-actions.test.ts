import "fake-indexeddb/auto";
import {openDB} from "idb";
import {describe, expect, it} from "vitest";
import {applyOperation, type Organization, type Operation} from "../../contracts/sync/protocol";
import {EncryptedOrganizationJournal, OrganizationActions} from "./organization-actions";
import type {SyncHead} from "./sync-v2-store";
const head: SyncHead = {protocol: 2, epoch: 1, kind: "organization", revision: "r", baseRevision: null, sequence: 1, stream: null, fence: null, owner: "test"};
function repository() {
  let state: Organization = {target: "conversation", fields: {customName: {revision: "seed", value: "Alice"}}, receipts: {}};
  let online = true;
  return {
    offline: () => {online = false;}, online: () => {online = true;},
    state: () => structuredClone(state),
    load: async () => {if (!online) throw new Error("offline"); return {head, state: structuredClone(state)};},
    apply: async (operation: Operation) => {if (!online) throw new Error("offline"); const result = applyOperation(state, operation); state = result.state; return result.result;}
  };
}
function journal(uid: string = crypto.randomUUID()) {return new EncryptedOrganizationJournal({uid, vaultId: "vault", epoch: 1, vaultKey: new Uint8Array(32).fill(7)});}
describe("conversation action integration", () => {
  it("persists encrypted intent before network and replays after restarting the controller", async () => {
    const repo = repository(), uid = crypto.randomUUID(), outbox = journal(uid);
    const actions = new OrganizationActions(repo, outbox);
    await actions.refresh(["conversation"]);
    repo.offline();
    await expect(actions.edit("conversation", current => ({...current, customName: "PRIVATE-RENAME"}))).rejects.toThrow("offline");
    const pending = await outbox.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.changes.customName?.expected).toBe("seed");
    const encrypted = await (await openDB("boxie-organization-outbox-v2", 1)).getAll("operations");
    expect(JSON.stringify(encrypted)).not.toContain("PRIVATE-RENAME");
    expect(await journal("other-user").list()).toEqual([]);
    repo.online();
    const restarted = new OrganizationActions(repo, journal(uid));
    expect((await restarted.refresh(["conversation"])).conversation?.customName).toBe("PRIVATE-RENAME");
    expect(await outbox.list()).toEqual([]);
  });
  it("surfaces a concurrent same-field edit and never overwrites it", async () => {
    const repo = repository(), actions = new OrganizationActions(repo, journal());
    await actions.refresh(["conversation"]);
    await repo.apply({id: "remote", target: "conversation", changes: {customName: {expected: "seed", value: "Remote name"}}});
    await expect(actions.edit("conversation", current => ({...current, customName: "Local name"}))).rejects.toThrow(/conflicts/);
    expect(repo.state().fields.customName?.value).toBe("Remote name");
  });
  it("captures only the message IDs selected by the original read action", async () => {
    const repo = repository(), outbox = journal(), actions = new OrganizationActions(repo, outbox);
    await actions.refresh(["conversation"]);
    repo.offline();
    await expect(actions.edit("conversation", current => ({...current, locallyReadMessageIds: ["visible-message"]}))).rejects.toThrow();
    expect((await outbox.list())[0]?.changes.locallyReadMessageIds?.value).toEqual(["visible-message"]);
    repo.online(); await actions.refresh(["conversation"]);
    expect(repo.state().fields.locallyReadMessageIds?.value).toEqual(["visible-message"]);
  });
});
