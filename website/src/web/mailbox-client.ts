import type {
  ConversationDetail,
  ConversationIndex
} from "../contracts/conversations";

export interface MailboxSyncStatus {
  enabled: boolean;
  state: "idle" | "syncing" | "error" | "unavailable";
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
  pollIntervalMs: number | null;
  encryptedReplica?: {
    state: "idle" | "syncing" | "error";
    pendingCount: number;
    lastSuccessfulAt: string | null;
    lastError: string | null;
  };
  localStorage?: {
    persistence: "persistent" | "best_effort" | "unavailable";
    usageBytes: number | null;
    quotaBytes: number | null;
    usageRatio: number | null;
    warning: string | null;
  };
}

export interface ModerationPolicy {
  junkRetentionDays: number;
  trashRetentionDays: number;
  outlookMutation: false;
}

export interface AssistantStatus {
  provider: "cursor-acp";
  modelId: string;
  modelName: string;
  available: boolean;
  hostedInference: true;
  privateToBoxie: true;
  outboundEmail: false;
  activation: "per_prompt";
}

export interface PrivateAssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  evidenceMessageIds: string[];
  createdAt: string;
}

export interface PrivateAssistantTurn {
  id: string;
  conversationId: string;
  provider: "cursor-acp";
  modelId: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  messages: PrivateAssistantMessage[];
}

export type ConversationAction =
  | "accept"
  | "keep_request"
  | "check_history"
  | "junk"
  | "not_junk"
  | "trash"
  | "restore";

export interface MailboxClient {
  readonly kind: "server" | "browser";
  loadIndex(signal?: AbortSignal): Promise<ConversationIndex>;
  loadDetail(conversationId: string, signal?: AbortSignal): Promise<ConversationDetail>;
  getSyncStatus(): Promise<MailboxSyncStatus>;
  refresh(): Promise<MailboxSyncStatus>;
  startBackgroundSync?(): () => void;
  getModerationPolicy(): Promise<ModerationPolicy>;
  getAssistantStatus(): Promise<AssistantStatus | null>;
  listAssistantTurns(conversationId: string, signal?: AbortSignal): Promise<PrivateAssistantTurn[]>;
  askBoxie(conversationId: string, question: string): Promise<PrivateAssistantTurn>;
  renameConversation(conversationId: string, name: string): Promise<ConversationDetail>;
  markConversationRead(conversationId: string): Promise<ConversationDetail>;
  markConversationUnread(conversationId: string): Promise<ConversationDetail>;
  runConversationAction(
    conversationId: string,
    action: ConversationAction
  ): Promise<ConversationDetail>;
}

export class ServerMailboxClient implements MailboxClient {
  readonly kind = "server" as const;

  async loadIndex(signal?: AbortSignal): Promise<ConversationIndex> {
    return requestJson<ConversationIndex>(
      "/api/conversations",
      signal ? { signal } : undefined
    );
  }

  async loadDetail(conversationId: string, signal?: AbortSignal): Promise<ConversationDetail> {
    return requestJson<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      signal ? { signal } : undefined
    );
  }

  getSyncStatus(): Promise<MailboxSyncStatus> {
    return requestJson<MailboxSyncStatus>("/api/sync/status");
  }

  refresh(): Promise<MailboxSyncStatus> {
    return requestJson<MailboxSyncStatus>("/api/sync", { method: "POST" });
  }

  getModerationPolicy(): Promise<ModerationPolicy> {
    return requestJson<ModerationPolicy>("/api/moderation/policy");
  }

  getAssistantStatus(): Promise<AssistantStatus | null> {
    return requestJson<AssistantStatus>("/api/assistant/status");
  }

  async listAssistantTurns(
    conversationId: string,
    signal?: AbortSignal
  ): Promise<PrivateAssistantTurn[]> {
    const payload = await requestJson<{ turns: PrivateAssistantTurn[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/assistant-turns`,
      signal ? { signal } : undefined
    );
    return payload.turns;
  }

  askBoxie(conversationId: string, question: string): Promise<PrivateAssistantTurn> {
    return requestJson<PrivateAssistantTurn>(
      `/api/conversations/${encodeURIComponent(conversationId)}/assistant-turns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question })
      }
    );
  }

  renameConversation(conversationId: string, name: string): Promise<ConversationDetail> {
    return requestJson<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(conversationId)}/name`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      }
    );
  }

  markConversationRead(conversationId: string): Promise<ConversationDetail> {
    return requestJson<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST" }
    );
  }

  markConversationUnread(conversationId: string): Promise<ConversationDetail> {
    return requestJson<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(conversationId)}/unread`,
      { method: "POST" }
    );
  }

  runConversationAction(
    conversationId: string,
    action: ConversationAction
  ): Promise<ConversationDetail> {
    const moderationAction = ["junk", "not_junk", "trash", "restore"].includes(action);
    const endpoint = moderationAction
      ? `/api/conversations/${encodeURIComponent(conversationId)}/moderation`
      : action === "check_history"
        ? `/api/conversations/${encodeURIComponent(conversationId)}/check-relationship`
        : `/api/conversations/${encodeURIComponent(conversationId)}/admission`;
    const body = moderationAction
      ? { action }
      : action === "check_history"
        ? undefined
        : { decision: action };
    return requestJson<ConversationDetail>(endpoint, {
      method: "POST",
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        : {})
    });
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
    throw new Error(message || `Boxie request failed (${response.status})`);
  }
  return payload as T;
}
