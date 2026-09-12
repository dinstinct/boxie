import { describe, expect, it } from "vitest";
import type { BrowserCanonicalMailbox, BrowserCanonicalMessage } from "./canonical-types";
import { projectBrowserConversations } from "./browser-conversation-projection";

const vaultKey = new Uint8Array(32).fill(9);

describe("projectBrowserConversations", () => {
  it("archives without removing mail and resurfaces only on newer incoming mail", async () => {
    const mailbox = exampleMailbox();
    const original = incoming("one", "thread", "Alice", "alice@example.com", "Hello", "Hello", "Hello");
    original.providerPayload.receivedDateTime = "2026-09-12T10:00:00Z";
    const project = (messages: BrowserCanonicalMessage[]) => projectBrowserConversations({ mailbox, vaultKey, messages });
    const initial = await project([original]);
    const id = initial.index.conversations.find(c => !c.isBoxie)!.id;
    mailbox.conversationPreferences[id] = { admission: "accepted", archivedAt: "2026-09-12T11:00:00.000Z" };
    expect((await project([original])).details.get(id)).toMatchObject({section: "archived", messageCount: 1, moderation: "normal"});
    const sent = outgoing("sent", "thread", "alice@example.com");
    sent.providerPayload.sentDateTime = "2026-09-12T12:00:00Z";
    expect((await project([original, sent])).details.get(id)?.section).toBe("archived");
    const old = structuredClone(original); old.providerMessageId = "old"; old.providerPayload.id = "old";
    old.providerPayload.receivedDateTime = "2026-09-11T10:00:00Z";
    expect((await project([original, old])).details.get(id)?.section).toBe("archived");
    const fresh = structuredClone(original); fresh.providerMessageId = "fresh"; fresh.providerPayload.id = "fresh";
    fresh.providerPayload.receivedDateTime = "2026-09-12T12:00:00Z";
    expect((await project([original, fresh])).details.get(id)?.section).toBe("chats");
    mailbox.conversationPreferences[id]!.moderation = "junk";
    expect((await project([original, fresh])).details.get(id)?.section).toBe("junk");
    mailbox.conversationPreferences[id] = { admission: "accepted", archivedAt: "" };
    expect((await project([original])).details.get(id)?.section).toBe("chats");
  });

  it("collapses people, preserves topics and originals, and renders CC as a group", async () => {
    const mailbox = exampleMailbox();
    const projection = await projectBrowserConversations({
      mailbox,
      vaultKey,
      messages: [
        incoming("alice-1", "thread-1", "Alice", "alice@example.com", "First", "Useful first", "Full first"),
        incoming("alice-2", "thread-2", "Alice", "alice@example.com", "Second", "Useful second", "Full second"),
        outgoing("mine-1", "thread-2", "alice@example.com"),
        incoming("group-1", "group-thread", "Carol", "carol@example.com", "Project", "Group update", "Full group", "bob@example.com"),
        incoming("robot-1", "robot-thread", "Updates", "no-reply@service.example", "Notice", "Automated", "Full automated")
      ]
    });

    expect(projection.index.conversations[0]).toMatchObject({ id: "boxie", isBoxie: true });
    const alice = projection.index.conversations.find((item) => item.address === "alice@example.com");
    expect(alice).toMatchObject({
      kind: "person",
      section: "chats",
      messageCount: 3,
      topicCount: 2,
      admissionSource: "post_activation_outgoing"
    });
    const aliceDetail = projection.details.get(alice!.id)!;
    expect(aliceDetail.messages[0]).toMatchObject({
      cleanedText: "Useful first",
      originalText: "Full first"
    });
    expect(aliceDetail.topics).toHaveLength(2);

    expect(projection.index.conversations.find((item) => item.kind === "group")).toMatchObject({
      name: "Project",
      section: "requests"
    });
    expect(projection.index.conversations.find((item) => item.address === "no-reply@service.example")).toMatchObject({
      kind: "channel",
      section: "requests"
    });
  });

  it("applies encrypted mailbox preferences to names, read state, and moderation", async () => {
    const messages = [
      incoming("alice-1", "thread-1", "Alice", "alice@example.com", "First", "Hello", "Hello")
    ];
    const first = await projectBrowserConversations({ mailbox: exampleMailbox(), messages, vaultKey });
    const aliceId = first.index.conversations.find((item) => item.address === "alice@example.com")!.id;
    const mailbox = exampleMailbox();
    mailbox.conversationPreferences[aliceId] = {
      customName: "Alice Projects",
      admission: "accepted",
      moderation: "junk",
      locallyReadMessageIds: ["alice-1"]
    };
    const projected = await projectBrowserConversations({ mailbox, messages, vaultKey });
    expect(projected.details.get(aliceId)).toMatchObject({
      name: "Alice Projects",
      section: "junk",
      moderation: "junk",
      unreadCount: 0
    });
  });

  it("preserves declared HTML bodies while deriving safe plain-text previews", async () => {
    const message = incoming(
      "html-1",
      "html-thread",
      "Alice",
      "alice@example.com",
      "Formatted",
      "unused",
      "unused"
    );
    message.providerPayload.uniqueBody = {
      contentType: "html",
      content: "<p>Hello <strong>Davide</strong></p>"
    };
    message.providerPayload.body = {
      contentType: "html",
      content: '<div>Hello <strong>Davide</strong></div><p><a href="https://example.com">Details</a></p>'
    };

    const projection = await projectBrowserConversations({
      mailbox: exampleMailbox(),
      vaultKey,
      messages: [message]
    });
    const projected = [...projection.details.values()]
      .find((conversation) => conversation.address === "alice@example.com")!
      .messages[0]!;

    expect(projected).toMatchObject({
      cleanedText: "Hello Davide",
      originalText: "Hello Davide\nDetails",
      cleanedBody: { format: "html", content: "<p>Hello <strong>Davide</strong></p>" },
      originalBody: { format: "html" }
    });
  });
});

function exampleMailbox(): BrowserCanonicalMailbox {
  const cursor = {
    deltaLink: null,
    lastStartedAt: null,
    lastCompletedAt: "2026-08-30T10:00:00.000Z",
    lastError: null
  };
  return {
    schemaVersion: 1,
    kind: "boxie-canonical-mailbox",
    messageStorageRevision: 2,
    accountScopeId: "account-scope",
    provider: "outlook",
    providerAccountId: "account-1",
    emailAddress: "me@example.com",
    informationSpace: "personal",
    activatedAt: "2026-08-30T10:00:00.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    cursors: { inbox: { ...cursor }, sent_items: { ...cursor } },
    conversationPreferences: {}
  };
}

function incoming(
  id: string,
  conversationId: string,
  name: string,
  address: string,
  subject: string,
  uniqueBody: string,
  body: string,
  cc?: string
): BrowserCanonicalMessage {
  return canonical(id, "incoming", {
    id,
    conversationId,
    subject,
    sender: { emailAddress: { name, address } },
    from: { emailAddress: { name, address } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@example.com" } }],
    ccRecipients: cc ? [{ emailAddress: { name: "Bob", address: cc } }] : [],
    receivedDateTime: `2026-08-30T10:0${id.length}:00.000Z`,
    isRead: false,
    uniqueBody: { contentType: "text", content: uniqueBody },
    body: { contentType: "text", content: body },
    webLink: "https://outlook.live.com/mail/0/id/example"
  });
}

function outgoing(id: string, conversationId: string, address: string): BrowserCanonicalMessage {
  return canonical(id, "outgoing", {
    id,
    conversationId,
    subject: "Re: Second",
    from: { emailAddress: { name: "Me", address: "me@example.com" } },
    toRecipients: [{ emailAddress: { name: "Alice", address } }],
    sentDateTime: "2026-08-30T10:09:00.000Z",
    body: { contentType: "text", content: "Reply" },
    uniqueBody: { contentType: "text", content: "Reply" },
    isRead: true
  });
}

function canonical(
  id: string,
  direction: "incoming" | "outgoing",
  providerPayload: BrowserCanonicalMessage["providerPayload"]
): BrowserCanonicalMessage {
  return {
    schemaVersion: 2,
    kind: "boxie-canonical-message",
    accountScopeId: "account-scope",
    provider: "outlook",
    providerMessageId: id,
    folderKind: direction === "incoming" ? "inbox" : "sent_items",
    direction,
    providerPayload,
    observedAt: "2026-08-30T10:10:00.000Z",
    updatedAt: "2026-08-30T10:10:00.000Z",
    providerRemovedAt: null,
    providerRemovedReason: null
  };
}
