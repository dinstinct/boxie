export const CONVERSATION_SNAPSHOT_SCHEMA_VERSION = 1;

export type ConversationKind = "person" | "group" | "channel";
export type ConversationSection =
  | "chats"
  | "requests"
  | "channels"
  | "archived"
  | "junk"
  | "trash";
export type ConversationAdmissionStatus =
  | "unverified"
  | "accepted"
  | "kept_request";
export type ConversationAdmissionSource =
  | "user"
  | "historical_correspondence"
  | "lookup_no_history"
  | "post_activation_outgoing";

export interface ConversationRecipient {
  kind: "from" | "sender" | "to" | "cc" | "bcc";
  name: string | null;
  address: string;
}

export interface ProjectedMessageBody {
  format: "text" | "html";
  content: string;
}

export interface ProjectedMessage {
  id: string;
  direction: "incoming" | "outgoing";
  authorName: string;
  authorAddress: string | null;
  subject: string;
  cleanedText: string;
  originalText: string;
  cleanedBody?: ProjectedMessageBody;
  originalBody?: ProjectedMessageBody;
  occurredAt: string;
  isRead: boolean | null;
  webLink: string | null;
  topicId: string;
  recipients: ConversationRecipient[];
}

export interface ConversationTopic {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
}

export interface ConversationSummary {
  id: string;
  isBoxie?: boolean;
  kind: ConversationKind;
  section: ConversationSection;
  name: string;
  address: string | null;
  initials: string;
  avatarSeed: string;
  preview: string;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  topicCount: number;
  admission: ConversationAdmissionStatus;
  admissionSource: ConversationAdmissionSource | null;
  admissionReason: string;
  relationshipCheckedAt: string | null;
  canCheckHistory: boolean;
  moderation: "normal" | "junk" | "trash";
}

export interface ConversationDetail extends ConversationSummary {
  topics: ConversationTopic[];
  messages: ProjectedMessage[];
}

export interface ConversationIndex {
  readOnly: true;
  coverage: {
    activatedAt: string | null;
    messageCount: number;
    note: string;
  };
  conversations: ConversationSummary[];
}

export interface ConversationSnapshot {
  schemaVersion: 1;
  kind: "boxie-conversation-snapshot";
  exportedAt: string;
  readOnly: true;
  coverage: ConversationIndex["coverage"];
  conversations: ConversationDetail[];
}

export interface ConversationSnapshotCounts {
  conversations: number;
  messages: number;
  utf8Bytes: number;
}

export function measureConversationSnapshot(
  snapshot: ConversationSnapshot
): ConversationSnapshotCounts {
  const serialized = JSON.stringify(snapshot);
  return {
    conversations: snapshot.conversations.length,
    messages: snapshot.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0
    ),
    utf8Bytes: new TextEncoder().encode(serialized).byteLength
  };
}

export function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ConversationSnapshot>;
  return candidate.schemaVersion === CONVERSATION_SNAPSHOT_SCHEMA_VERSION
    && candidate.kind === "boxie-conversation-snapshot"
    && typeof candidate.exportedAt === "string"
    && candidate.readOnly === true
    && Boolean(candidate.coverage && typeof candidate.coverage === "object")
    && Array.isArray(candidate.conversations)
    && candidate.conversations.every((conversation) =>
      Boolean(conversation)
      && typeof conversation.id === "string"
      && Array.isArray(conversation.messages)
      && conversation.messages.every((message) =>
        Boolean(message)
        && typeof message.id === "string"
        && typeof message.originalText === "string"
        && isProjectedMessageBody(message.cleanedBody)
        && isProjectedMessageBody(message.originalBody)
        && Array.isArray(message.recipients)
      )
    );
}

function isProjectedMessageBody(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectedMessageBody>;
  return (candidate.format === "text" || candidate.format === "html")
    && typeof candidate.content === "string";
}
