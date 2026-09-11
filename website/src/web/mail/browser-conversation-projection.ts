import type {
  ConversationDetail,
  ConversationIndex,
  ConversationKind,
  ConversationRecipient,
  ConversationSection,
  ConversationTopic,
  ProjectedMessageBody,
  ProjectedMessage
} from "../../contracts/conversations";
import { deriveOpaqueObjectId } from "../vault-spike/crypto";
import type {
  BrowserCanonicalMailbox,
  BrowserCanonicalMessage,
  BrowserConversationPreference
} from "./canonical-types";

interface WorkingMessage {
  source: BrowserCanonicalMessage;
  occurredAt: string;
  counterpartAddress: string | null;
  counterpartName: string;
  recipients: ConversationRecipient[];
  group: boolean;
  automated: boolean;
  conversationKey: string;
}

export interface BrowserConversationProjectionResult {
  index: ConversationIndex;
  details: Map<string, ConversationDetail>;
}

export async function projectBrowserConversations(input: {
  mailbox: BrowserCanonicalMailbox;
  messages: BrowserCanonicalMessage[];
  vaultKey: Uint8Array;
}): Promise<BrowserConversationProjectionResult> {
  const activeMessages = input.messages.filter((message) => !message.providerRemovedAt);
  const working = activeMessages.map((message) => toWorkingMessage(input.mailbox, message));
  const groups = new Map<string, WorkingMessage[]>();
  for (const message of working) {
    const messages = groups.get(message.conversationKey) ?? [];
    messages.push(message);
    groups.set(message.conversationKey, messages);
  }

  const projected = await Promise.all([...groups.entries()].map(async ([key, messages]) => {
    const id = await deriveOpaqueObjectId({
      vaultKey: input.vaultKey,
      namespace: "browser-conversation",
      logicalId: `${input.mailbox.accountScopeId}\0${key}`
    });
    return projectConversation(id, messages, input.mailbox.conversationPreferences[id] ?? {});
  }));
  projected.sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));

  const boxie = createBoxieGuide(input.mailbox.activatedAt);
  const conversations = [boxie, ...projected];
  return {
    index: {
      readOnly: true,
      coverage: {
        activatedAt: input.mailbox.activatedAt,
        messageCount: activeMessages.length,
        note: "Boxie shows mail received or sent after activation. Older history has not been loaded."
      },
      conversations: conversations.map(({ topics: _topics, messages: _messages, ...summary }) => summary)
    },
    details: new Map(conversations.map((conversation) => [conversation.id, conversation]))
  };
}

export function toWorkingMessage(
  mailbox: BrowserCanonicalMailbox,
  source: BrowserCanonicalMessage
): WorkingMessage {
  const payload = source.providerPayload;
  const ownAddress = normalizeAddress(mailbox.emailAddress);
  const recipients = messageRecipients(payload);
  const sender = preferredRecipient(recipients, ["sender", "from"]);
  const externalTo = recipients.filter((recipient) =>
    (recipient.kind === "to" || recipient.kind === "cc") &&
    normalizeAddress(recipient.address) !== ownAddress
  );
  const group = recipients.some((recipient) => recipient.kind === "cc") ||
    (source.direction === "outgoing" && uniqueAddresses(externalTo).length > 1);
  const counterpart = source.direction === "incoming"
    ? sender
    : externalTo.find((recipient) => recipient.kind === "to") ?? externalTo[0];
  const counterpartAddress = counterpart ? normalizeAddress(counterpart.address) : null;
  const counterpartName = counterpart?.name?.trim() || counterpart?.address || "Unknown sender";
  const providerThread = payload.conversationId ?? source.providerMessageId;
  const conversationKey = group
    ? `group:${providerThread}`
    : counterpartAddress
      ? `person:${counterpartAddress}`
      : `message:${source.providerMessageId}`;
  return {
    source,
    occurredAt: payload.receivedDateTime ?? payload.sentDateTime ?? source.observedAt,
    counterpartAddress,
    counterpartName,
    recipients,
    group,
    automated: isAutomatedAddress(counterpartAddress),
    conversationKey
  };
}

function projectConversation(
  id: string,
  inputMessages: WorkingMessage[],
  preference: BrowserConversationPreference
): ConversationDetail {
  const messages = [...inputMessages].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
  );
  const latest = messages.at(-1)!;
  const hasOutgoing = messages.some((message) => message.source.direction === "outgoing");
  const kind: ConversationKind = messages.some((message) => message.group)
    ? "group"
    : messages.every((message) => message.automated)
      ? "channel"
      : "person";
  const admission = preference.admission ?? (hasOutgoing ? "accepted" : "unverified");
  const admissionSource = preference.admission
    ? "user"
    : hasOutgoing
      ? "post_activation_outgoing"
      : null;
  const moderation = preference.moderation ?? "normal";
  const section: ConversationSection = moderation === "trash"
    ? "trash"
    : moderation === "junk"
      ? "junk"
      : admission === "accepted"
        ? kind === "channel" ? "channels" : "chats"
        : "requests";
  const defaultName = kind === "group"
    ? cleanSubject(latest.source.providerPayload.subject) || participantLabel(messages)
    : latest.counterpartName;
  const name = preference.customName?.trim() || defaultName;
  const projectedMessages = messages.map((message) => projectMessage(message, preference));
  const topics = projectTopics(messages);
  return {
    id,
    kind,
    section,
    name,
    address: kind === "person" || kind === "channel" ? latest.counterpartAddress : null,
    initials: initialsFor(name),
    avatarSeed: latest.counterpartAddress ?? latest.conversationKey,
    preview: previewText(projectedMessages.at(-1)?.cleanedText ?? ""),
    lastMessageAt: latest.occurredAt,
    messageCount: messages.length,
    unreadCount: projectedMessages.filter((message) =>
      message.direction === "incoming" && message.isRead === false
    ).length,
    topicCount: topics.length,
    admission,
    admissionSource,
    admissionReason: admissionReason(admission, admissionSource),
    relationshipCheckedAt: null,
    canCheckHistory: false,
    moderation,
    topics,
    messages: projectedMessages
  };
}

function projectMessage(
  message: WorkingMessage,
  preference: BrowserConversationPreference
): ProjectedMessage {
  const payload = message.source.providerPayload;
  const unique = projectBody(payload.uniqueBody);
  const original = projectBody(payload.body);
  const uniqueText = unique?.text ?? "";
  const originalText = original?.text || payload.bodyPreview?.trim() || "";
  const cleanedText = uniqueText || originalText || "This message has no readable text body.";
  const fallbackBody: ProjectedMessageBody = { format: "text", content: cleanedText };
  const readIds = new Set(preference.locallyReadMessageIds ?? []);
  const unreadIds = new Set(preference.locallyUnreadMessageIds ?? []);
  const isRead = unreadIds.has(message.source.providerMessageId)
    ? false
    : readIds.has(message.source.providerMessageId)
      ? true
      : (payload.isRead ?? null);
  return {
    id: message.source.providerMessageId,
    direction: message.source.direction,
    authorName: message.source.direction === "outgoing" ? "You" : message.counterpartName,
    authorAddress: message.source.direction === "outgoing" ? null : message.counterpartAddress,
    subject: payload.subject?.trim() || "No subject",
    cleanedText,
    originalText: originalText || cleanedText,
    cleanedBody: unique?.body ?? original?.body ?? fallbackBody,
    originalBody: original?.body ?? unique?.body ?? fallbackBody,
    occurredAt: message.occurredAt,
    isRead,
    webLink: safeOutlookLink(payload.webLink),
    topicId: payload.conversationId ?? message.source.providerMessageId,
    recipients: message.recipients
  };
}

function projectTopics(messages: WorkingMessage[]): ConversationTopic[] {
  const topics = new Map<string, ConversationTopic>();
  for (const message of messages) {
    const id = message.source.providerPayload.conversationId ?? message.source.providerMessageId;
    const existing = topics.get(id);
    if (existing) {
      existing.messageCount += 1;
      existing.lastMessageAt = message.occurredAt;
    } else {
      topics.set(id, {
        id,
        title: cleanSubject(message.source.providerPayload.subject) || "No subject",
        messageCount: 1,
        lastMessageAt: message.occurredAt
      });
    }
  }
  return [...topics.values()].sort((left, right) =>
    right.lastMessageAt.localeCompare(left.lastMessageAt)
  );
}

function messageRecipients(payload: BrowserCanonicalMessage["providerPayload"]): ConversationRecipient[] {
  const result: ConversationRecipient[] = [];
  const add = (
    kind: ConversationRecipient["kind"],
    recipients: Array<{
      emailAddress?: {
        name?: string | null | undefined;
        address?: string | null | undefined;
      } | null | undefined;
    }> | null | undefined
  ) => {
    for (const recipient of recipients ?? []) {
      const address = recipient.emailAddress?.address?.trim();
      if (!address) continue;
      result.push({ kind, name: recipient.emailAddress?.name?.trim() || null, address });
    }
  };
  add("sender", payload.sender ? [payload.sender] : []);
  add("from", payload.from ? [payload.from] : []);
  add("to", payload.toRecipients);
  add("cc", payload.ccRecipients);
  add("bcc", payload.bccRecipients);
  return result;
}

function createBoxieGuide(activatedAt: string): ConversationDetail {
  const welcome = "Hey, I’m Boxie. Your encrypted Outlook mail is now organized into people, groups, and channels. I’ll keep it refreshed while this app is open; the private assistant connection is the next layer being wired into this browser version.";
  return {
    id: "boxie",
    isBoxie: true,
    kind: "person",
    section: "chats",
    name: "Boxie",
    address: null,
    initials: "BX",
    avatarSeed: "boxie",
    preview: "Your encrypted Outlook mail is now conversations.",
    lastMessageAt: activatedAt,
    messageCount: 1,
    unreadCount: 0,
    topicCount: 1,
    admission: "accepted",
    admissionSource: "user",
    admissionReason: "Boxie is your private email assistant.",
    relationshipCheckedAt: null,
    canCheckHistory: false,
    moderation: "normal",
    topics: [{ id: "boxie-introduction", title: "Meet Boxie", messageCount: 1, lastMessageAt: activatedAt }],
    messages: [{
      id: "boxie-guide-v1",
      direction: "incoming",
      authorName: "Boxie",
      authorAddress: null,
      subject: "Welcome to Boxie",
      cleanedText: welcome,
      originalText: welcome,
      occurredAt: activatedAt,
      isRead: true,
      webLink: null,
      topicId: "boxie-introduction",
      recipients: []
    }]
  };
}

function preferredRecipient(
  recipients: ConversationRecipient[],
  kinds: ConversationRecipient["kind"][]
): ConversationRecipient | undefined {
  for (const kind of kinds) {
    const recipient = recipients.find((candidate) => candidate.kind === kind);
    if (recipient) return recipient;
  }
  return undefined;
}

function uniqueAddresses(recipients: ConversationRecipient[]): string[] {
  return [...new Set(recipients.map((recipient) => normalizeAddress(recipient.address)))];
}

function bodyText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const body = value as { content?: unknown; contentType?: unknown };
  if (typeof body.content !== "string") return "";
  const content = typeof body.contentType === "string" && body.contentType.toLowerCase() === "html"
    ? htmlToText(body.content)
    : body.content;
  return normalizeText(content);
}

function projectBody(value: unknown): { body: ProjectedMessageBody; text: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { content?: unknown; contentType?: unknown };
  if (typeof candidate.content !== "string" || !candidate.content.trim()) return null;
  const format = typeof candidate.contentType === "string"
    && candidate.contentType.toLowerCase() === "html"
    ? "html"
    : "text";
  return {
    body: {
      format,
      content: format === "text" ? normalizeText(candidate.content) : candidate.content
    },
    text: bodyText(candidate)
  };
}

function htmlToText(value: string): string {
  return normalizeText(value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'"));
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function isAutomatedAddress(address: string | null): boolean {
  const localPart = address?.split("@", 1)[0] ?? "";
  return /(?:^|[-_.])(no-?reply|do-?not-?reply|mailer-daemon)(?:$|[-_.])/i.test(localPart);
}

function admissionReason(
  admission: "unverified" | "accepted" | "kept_request",
  source: "user" | "post_activation_outgoing" | null
): string {
  if (admission === "accepted" && source === "user") return "You accepted this sender.";
  if (admission === "accepted") return "A conversation already exists after Boxie started.";
  if (admission === "kept_request") return "You chose to keep this conversation in Requests.";
  return "No post-activation reply exists yet; earlier mailbox history has not been checked.";
}

function participantLabel(messages: WorkingMessage[]): string {
  return [...new Set(messages.map((message) => message.counterpartName))].slice(0, 3).join(", ") || "Group conversation";
}

function cleanSubject(value: string | null | undefined): string {
  return (value ?? "").replace(/^\s*((re|fw|fwd):\s*)+/gi, "").trim();
}

function previewText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 116 ? `${collapsed.slice(0, 113)}…` : collapsed;
}

function initialsFor(value: string): string {
  const parts = value.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts.at(-1)?.[0] ?? "" : ""}`.toUpperCase();
}

function normalizeAddress(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function safeOutlookLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && [
      "outlook.live.com",
      "outlook.office.com",
      "outlook.office365.com"
    ].includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
