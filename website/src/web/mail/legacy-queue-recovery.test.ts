import "fake-indexeddb/auto";
import {describe, it, expect} from "vitest";
import {encryptJsonObject} from "../vault-spike/crypto";
import {CANONICAL_MAILBOX_CONTENT_TYPE} from "../vault-spike/types";
import {IndexedDbEncryptedCanonicalRepository} from "./encrypted-canonical-repository";
import {recoverRepresentedLegacyQueue, representedInBaseline} from "./legacy-queue-recovery";
const base = {kind: "boxie-canonical-mailbox", accountScopeId: "mailbox", providerAccountId: "personal", activatedAt: "T0", cursors: {}, conversationPreferences: {c: {customName: "Name"}}};
describe("legacy queue recovery", () => {
  it("ignores obsolete cursors but preserves unexplained preference and identity changes", () => {
    expect(representedInBaseline({...base, cursors: {inbox: "new"}, updatedAt: "later"}, base)).toBe(true);
    expect(representedInBaseline({...base, conversationPreferences: {}}, base)).toBe(true);
    expect(representedInBaseline({...base, conversationPreferences: {c: {customName: "Offline choice"}}}, base)).toBe(false);
    expect(representedInBaseline({...base, activatedAt: "different"}, base)).toBe(false);
    expect(representedInBaseline({...base, providerAccountId: "work"}, base)).toBe(false);
  });
  it("requires matching source content and removal state", () => {
    const message = {kind: "boxie-canonical-message", accountScopeId: "mailbox", providerPayload: {body: "source"}, providerRemovedAt: null};
    expect(representedInBaseline({...message, observedAt: "later"}, message)).toBe(true);
    expect(representedInBaseline({...message, providerPayload: {body: "changed"}}, message)).toBe(false);
    expect(representedInBaseline({...message, providerRemovedAt: "removed"}, message)).toBe(false);
  });
  it("backs up before acknowledging and preserves a racing local rewrite", async () => {
    const vault = {uid: crypto.randomUUID(), vaultId: "test", epoch: 1, vaultKey: new Uint8Array(32).fill(7)};
    const queue = new IndexedDbEncryptedCanonicalRepository(vault.uid, vault.vaultId);
    const record = async (payload: unknown) => ({objectId: "mailbox", accountScopeId: "mailbox", kind: "mailbox" as const,
      encrypted: await encryptJsonObject({...vault, objectId: "mailbox", contentType: CANONICAL_MAILBOX_CONTENT_TYPE, payload})});
    const frozen = await record(base), first = await record({...base, updatedAt: "later"});
    await queue.putMany([first]);
    const cloud = {get: async () => frozen};
    await expect(recoverRepresentedLegacyQueue({queue, cloud, vault, archive: async () => {throw new Error("disk full");}})).rejects.toThrow("disk full");
    expect(await queue.pendingCount()).toBe(1);
    await recoverRepresentedLegacyQueue({queue, cloud, vault, archive: async () => {await queue.putMany([await record({...base, conversationPreferences: {c: {customName: "New"}}})]);}});
    expect(await queue.pendingCount()).toBe(1);
    expect((await recoverRepresentedLegacyQueue({queue, cloud, vault})).remaining).toBe(1);
    await queue.putMany([first]);
    expect((await recoverRepresentedLegacyQueue({queue, cloud, vault})).remaining).toBe(0);
  });
});
