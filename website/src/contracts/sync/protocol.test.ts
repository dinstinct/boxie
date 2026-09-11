import {describe, expect, it} from "vitest";
import {acquireLease, applyOperation, assertLease, hydrateBase, publishRound, stageRevision, type Organization, type StreamState} from "./protocol.js";
const organization = (): Organization => ({target: "conversation", fields: {}, receipts: {}});
const op = (id: string, field: string, value: unknown, expected: string | null = null) => ({id, target: "conversation", changes: {[field]: {value, expected}}});
const stream = (): StreamState => ({lease: acquireLease(null, "mac", 1000, 1000), revisions: {}, heads: {}, checkpoint: null});
const round = {lease: {owner: "mac", fence: 1}, expectedCheckpoint: null, cursor: "delta", messages: [{objectId: "message", revision: "revision", expectedHead: null}]};

describe("sync v2 operations", () => {
  it("merges independent fields in either order", () => {
    const a = op("rename", "name", "Alice"), b = op("accept", "admission", "accepted");
    const ab = applyOperation(applyOperation(organization(), a).state, b).state;
    const ba = applyOperation(applyOperation(organization(), b).state, a).state;
    expect(ab).toEqual(ba);
  });
  it("surfaces stale same-field edits without changing the winner", () => {
    const state = applyOperation(organization(), op("one", "name", "Alice")).state;
    const conflict = applyOperation(state, op("two", "name", "Bob"));
    expect(conflict.result).toEqual({status: "conflict", fields: ["name"]});
    expect(conflict.state.fields).toEqual(state.fields);
    expect(applyOperation(conflict.state, op("three", "name", "Bob", "one")).result.status).toBe("applied");
  });
  it("deduplicates retries including after a later edit", () => {
    const first = op("one", "name", "Alice");
    const state = applyOperation(applyOperation(organization(), first).state, op("two", "name", "Bob", "one")).state;
    expect(applyOperation(state, first).state).toBe(state);
    expect(() => applyOperation(state, op("one", "name", "Charlie"))).toThrow(/reused/);
  });
  it("rejects wrong targets and prototype keys", () => {
    expect(() => applyOperation(organization(), {...op("one", "name", "Alice"), target: "other"})).toThrow(/target/);
    expect(() => applyOperation(organization(), op("one", "__proto__", "bad"))).toThrow();
  });
  it("does not partially apply a compound operation", () => {
    const state = applyOperation(organization(), op("one", "name", "Alice")).state;
    const result = applyOperation(state, {id: "two", target: "conversation", changes: {name: {expected: null, value: "Bob"}, admission: {expected: null, value: "accepted"}}});
    expect(result.state.fields).toEqual(state.fields);
  });
});

describe("sync v2 ingestion", () => {
  it("fences suspended owners and expired owners even before takeover", () => {
    const old = acquireLease(null, "mac", 1000, 1000);
    expect(() => assertLease(old, old, 2000)).toThrow();
    const next = acquireLease(old, "android", 2000, 1000);
    expect(next.fence).toBe(2);
    expect(() => assertLease(next, old, 2001)).toThrow();
    expect(() => acquireLease(next, "web", 2001, 1000)).toThrow();
    expect(acquireLease(next, "android", 2200, 1000).fence).toBe(2);
  });
  it("keeps revisions immutable and publication blocked until data exists", () => {
    const state = stream();
    expect(() => publishRound(state, round, 1100)).toThrow(/durable/);
    const staged = stageRevision(state, {id: "revision", chunks: ["opaque-a", "opaque-b"]});
    expect(() => stageRevision(staged, {id: "revision", chunks: ["changed"]})).toThrow(/collision/);
    expect(staged.heads).toEqual({});
    const published = publishRound(staged, round, 1100);
    expect(published.checkpoint?.sequence).toBe(1);
    expect(published.heads.message?.revision).toBe("revision");
    expect(() => publishRound(published, round, 1200)).toThrow(/Checkpoint/);
  });
  it("preserves the previous complete revision when staging crashes", () => {
    const state = publishRound(stageRevision(stream(), {id: "revision", chunks: ["a"]}), round, 1100);
    const staged = stageRevision(state, {id: "next", chunks: ["b"]});
    expect(staged.heads).toEqual(state.heads);
    expect(staged.checkpoint).toEqual(state.checkpoint);
  });
  it("publishes neither heads nor cursor when one dependency is absent", () => {
    const staged = stageRevision(stream(), {id: "revision", chunks: ["a"]});
    expect(() => publishRound(staged, {...round, messages: [...round.messages, {objectId: "missing", revision: "missing", expectedHead: null}]}, 1100)).toThrow();
    expect(staged.heads).toEqual({});
    expect(staged.checkpoint).toBeNull();
  });
  it("does not generate a changed base on repeated pulls", () => {
    const value = {revision: "revision", value: {name: "Alice"}};
    expect(hydrateBase(value, structuredClone(value))).toBe(value);
    expect(hydrateBase(value, {revision: "next", value: {name: "Bob"}})?.value.name).toBe("Bob");
  });
});
