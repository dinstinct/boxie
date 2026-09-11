import type {
  GraphMessage,
  OutlookFolderKind
} from "../../server/providers/outlook/types";

export interface BrowserSyncCursor {
  deltaLink: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
}

export interface BrowserConversationPreference {
  customName?: string;
  admission?: "accepted" | "kept_request";
  moderation?: "normal" | "junk" | "trash";
  locallyReadMessageIds?: string[];
  locallyUnreadMessageIds?: string[];
}

export interface BrowserCanonicalMailbox {
  schemaVersion: 1;
  kind: "boxie-canonical-mailbox";
  messageStorageRevision: 2;
  accountScopeId: string;
  provider: "outlook";
  providerAccountId: string;
  emailAddress: string;
  informationSpace: "personal";
  activatedAt: string;
  createdAt: string;
  updatedAt: string;
  cursors: Record<OutlookFolderKind, BrowserSyncCursor>;
  conversationPreferences: Record<string, BrowserConversationPreference>;
}

export interface BrowserCanonicalMessage {
  schemaVersion: 2;
  kind: "boxie-canonical-message";
  accountScopeId: string;
  provider: "outlook";
  providerMessageId: string;
  folderKind: OutlookFolderKind;
  direction: "incoming" | "outgoing";
  providerPayload: GraphMessage;
  observedAt: string;
  updatedAt: string;
  providerRemovedAt: string | null;
  providerRemovedReason: string | null;
}

export function assertCanonicalMailbox(value: unknown): BrowserCanonicalMailbox {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<BrowserCanonicalMailbox>).schemaVersion !== 1 ||
    (value as Partial<BrowserCanonicalMailbox>).kind !== "boxie-canonical-mailbox" ||
    typeof (value as Partial<BrowserCanonicalMailbox>).accountScopeId !== "string" ||
    typeof (value as Partial<BrowserCanonicalMailbox>).providerAccountId !== "string" ||
    typeof (value as Partial<BrowserCanonicalMailbox>).activatedAt !== "string"
  ) {
    throw new Error("The encrypted browser mailbox has an unsupported schema.");
  }
  const mailbox = value as BrowserCanonicalMailbox;
  if (!mailbox.cursors?.inbox || !mailbox.cursors?.sent_items) {
    throw new Error("The encrypted browser mailbox is missing sync checkpoints.");
  }
  return {
    ...mailbox,
    messageStorageRevision: 2,
    conversationPreferences: mailbox.conversationPreferences ?? {}
  };
}

export function assertCanonicalMessage(value: unknown): BrowserCanonicalMessage {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<BrowserCanonicalMessage>).kind !== "boxie-canonical-message" ||
    typeof (value as Partial<BrowserCanonicalMessage>).providerMessageId !== "string" ||
    ![1, 2].includes(Number((value as { schemaVersion?: unknown }).schemaVersion))
  ) {
    throw new Error("The encrypted browser message has an unsupported schema.");
  }
  const {
    rawMimeBase64Url: _rawMimeBase64Url,
    rawMimeByteLength: _rawMimeByteLength,
    ...message
  } = value as BrowserCanonicalMessage & {
    rawMimeBase64Url?: string;
    rawMimeByteLength?: number;
  };
  return {
    ...message,
    schemaVersion: 2
  };
}

export function needsCanonicalMessageStorageMigration(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "boxie-canonical-message" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  );
}
