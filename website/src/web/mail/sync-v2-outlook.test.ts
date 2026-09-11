import {describe, expect, it} from "vitest";
import {mergeSourceMemberships, normalizeSource} from "./sync-v2-outlook";
import type {BrowserCanonicalMailbox, BrowserCanonicalMessage} from "./canonical-types";
import type {GraphMessage} from "../../server/providers/outlook/types";
const mailbox = {accountScopeId: "scope", activatedAt: "2026-09-01T00:00:00Z"} as BrowserCanonicalMailbox;
const item = {id: "m1", receivedDateTime: "2026-09-02T00:00:00Z", lastModifiedDateTime: "2026-09-02T00:00:00Z", subject: "synthetic"} as GraphMessage;
const message = normalizeSource(mailbox, "inbox", item, undefined, "2026-09-03T00:00:00Z")!;
describe("source membership policy", () => {
  it("does not re-encrypt identical or older provider versions and respects T0", () => {
    expect(normalizeSource(mailbox, "inbox", item, message, "later")).toBeNull();
    expect(normalizeSource(mailbox, "inbox", {...item, lastModifiedDateTime: "2026-09-01T00:00:00Z"}, message, "later")).toBeNull();
    expect(normalizeSource(mailbox, "inbox", {...item, receivedDateTime: "2026-08-31T00:00:00Z"}, undefined, "later")).toBeNull();
  });
  it("merges partial delta patches without dropping previously loaded source fields", () => {
    const changed = normalizeSource(mailbox, "inbox", {id: "m1", isRead: true}, message, "later")!;
    expect(changed.providerPayload).toMatchObject({...item, isRead: true});
    expect(normalizeSource(mailbox, "inbox", {id: "m1", isRead: true}, changed, "later")).toBeNull();
  });
  it("folder removal cannot hide a live membership in another folder", () => {
    const removed = {...message, providerRemovedAt: "removed"};
    const sent = {...message, folderKind: "sent_items", direction: "outgoing"} as BrowserCanonicalMessage;
    expect(mergeSourceMemberships([message], [sent, removed])).toEqual([sent]);
    expect(mergeSourceMemberships([message], [removed, sent])).toEqual([sent]);
    expect(normalizeSource(mailbox, "inbox", {id: "m1", "@removed": {reason: "deleted"}}, removed, "later")).toBeNull();
  });
});
