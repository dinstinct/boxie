import {
  ArrowLeft,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Ellipsis,
  Hash,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MailOpen,
  MessageCircle,
  PencilLine,
  RefreshCw,
  Search,
  Send,
  Share2,
  ShieldBan,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  UsersRound
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent
} from "react";
import type {
  ConversationDetail,
  ConversationIndex,
  ConversationKind,
  ConversationSection,
  ConversationSummary,
  ProjectedMessage
} from "../contracts/conversations";
import { SafeMessageBody } from "./email/SafeMessageBody";
import {
  ServerMailboxClient,
  type AssistantStatus,
  type ConversationAction,
  type MailboxClient,
  type MailboxSyncStatus,
  type ModerationPolicy,
  type PrivateAssistantTurn
} from "./mailbox-client";

type Section = ConversationSection | "recent";
type ViewMode = "stream" | "topics";

interface ConversationMenuState {
  conversation: ConversationSummary;
  x: number;
  y: number;
}

interface RenameDialogState {
  conversation: ConversationSummary;
  name: string;
}

type IndexState =
  | { kind: "loading" }
  | { kind: "loaded"; data: ConversationIndex }
  | { kind: "error"; message: string };

type DetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; data: ConversationDetail }
  | { kind: "error"; message: string };

type AssistantTurnsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; turns: PrivateAssistantTurn[] }
  | { kind: "error"; message: string };

const sections: Array<{
  id: Section;
  label: string;
  icon: typeof MessageCircle;
}> = [
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "requests", label: "Requests", icon: Inbox },
  { id: "channels", label: "Channels", icon: Hash },
  { id: "recent", label: "Recent", icon: Clock3 },
  { id: "junk", label: "Junk", icon: ShieldBan },
  { id: "trash", label: "Trash", icon: Trash2 }
];

const mobilePrimarySections = sections.filter(({ id }) =>
  ["chats", "requests", "channels", "junk"].includes(id)
);

const defaultMailboxClient = new ServerMailboxClient();

export function App({
  mailboxClient = defaultMailboxClient
}: {
  mailboxClient?: MailboxClient;
} = {}) {
  const [indexState, setIndexState] = useState<IndexState>({ kind: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [section, setSection] = useState<Section>("requests");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("stream");
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "conversation">("list");
  const [conversationAction, setConversationAction] = useState<ConversationAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<MailboxSyncStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [moderationPolicy, setModerationPolicy] = useState<ModerationPolicy>({
    junkRetentionDays: 30,
    trashRetentionDays: 30,
    outlookMutation: false
  });
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus | null>(null);
  const [assistantTurnsState, setAssistantTurnsState] = useState<AssistantTurnsState>({ kind: "idle" });
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [assistantSubmitting, setAssistantSubmitting] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<ConversationMenuState | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [desktopRailExpanded, setDesktopRailExpanded] = useState(() => {
    try {
      return window.localStorage.getItem("boxie.desktopRail") !== "collapsed";
    } catch {
      return true;
    }
  });
  const selectedIdRef = useRef<string | null>(null);
  const lastObservedSyncRef = useRef<string | null>(null);
  const pullStartYRef = useRef<number | null>(null);
  const conversationMenuRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    mailboxClient.loadIndex(controller.signal)
      .then((data) => {
        setIndexState({ kind: "loaded", data });
        const requestedConversationId = new URLSearchParams(window.location.search)
          .get("conversation");
        const requestedConversation = requestedConversationId
          ? data.conversations.find((conversation) => conversation.id === requestedConversationId)
          : undefined;
        const first = requestedConversation ??
          data.conversations.find((conversation) => conversation.section === "chats") ??
          data.conversations.find((conversation) => conversation.section === "requests") ??
          data.conversations[0];
        if (first) {
          setSelectedId(first.id);
          setSection(first.section);
          if (requestedConversation && window.matchMedia("(max-width: 760px)").matches) {
            setMobilePane("conversation");
          }
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setIndexState({
            kind: "error",
            message: error instanceof Error ? error.message : "Unknown error"
          });
        }
      });
    return () => controller.abort();
  }, [mailboxClient]);

  useEffect(() => {
    if (!selectedId) {
      setDetailState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setDetailState({ kind: "loading" });
    mailboxClient.loadDetail(selectedId, controller.signal)
      .then((data) => {
        setDetailState({ kind: "loaded", data });
        setSelectedTopicId(data.topics[0]?.id ?? null);
        const conversationIsVisible =
          mobilePane === "conversation" ||
          window.matchMedia("(min-width: 761px)").matches;
        if (conversationIsVisible && data.unreadCount > 0) {
          void markConversationRead(data.id);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDetailState({
            kind: "error",
            message: error instanceof Error ? error.message : "Unknown error"
          });
        }
      });
    return () => controller.abort();
  }, [selectedId, mobilePane, mailboxClient]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    mailboxClient.getModerationPolicy()
      .then((policy) => {
        if (policy) setModerationPolicy(policy);
      })
      .catch(() => undefined);
  }, [mailboxClient]);

  useEffect(() => {
    mailboxClient.getAssistantStatus()
      .then((status) => setAssistantStatus(status))
      .catch(() => setAssistantStatus(null));
  }, [mailboxClient]);

  useEffect(() => {
    if (!selectedId) {
      setAssistantTurnsState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setAssistantTurnsState({ kind: "loading" });
    setAssistantQuestion("");
    setAssistantError(null);
    mailboxClient.listAssistantTurns(selectedId, controller.signal)
      .then((turns) => setAssistantTurnsState({ kind: "loaded", turns }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setAssistantTurnsState({
            kind: "error",
            message: error instanceof Error ? error.message : "Private conversation unavailable"
          });
        }
      });
    return () => controller.abort();
  }, [selectedId, mailboxClient]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "boxie.desktopRail",
        desktopRailExpanded ? "expanded" : "collapsed"
      );
    } catch {
      // The layout still works when browser storage is unavailable.
    }
  }, [desktopRailExpanded]);

  useEffect(() => {
    if (!conversationMenu) return;

    conversationMenuRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();

    const closeOutside = (event: PointerEvent) => {
      if (!conversationMenuRef.current?.contains(event.target as Node)) {
        setConversationMenu(null);
      }
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversationMenu(null);
    };
    const close = () => setConversationMenu(null);

    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [conversationMenu]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;

    const checkStatus = async () => {
      try {
        const status = await mailboxClient.getSyncStatus();
        if (!active) return;
        setSyncStatus(status);
        const previous = lastObservedSyncRef.current;
        lastObservedSyncRef.current = status.lastSuccessfulAt;
        if (
          status.lastSuccessfulAt !== null &&
          status.lastSuccessfulAt !== previous
        ) {
          await reloadMailboxView();
        }
      } catch {
        // Keep the last good mailbox view while status polling recovers.
      }
    };

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [mailboxClient]);

  useEffect(() => mailboxClient.startBackgroundSync?.(), [mailboxClient]);

  const index = indexState.kind === "loaded" ? indexState.data : null;
  const conversations = index?.conversations ?? [];
  const notificationCounts = useMemo(
    () => ({
      chats: conversations
        .filter((conversation) => conversation.section === "chats")
        .reduce((total, conversation) => total + conversation.unreadCount, 0),
      requests: conversations
        .filter((conversation) => conversation.section === "requests")
        .reduce((total, conversation) => total + conversation.unreadCount, 0),
      channels: conversations
        .filter((conversation) => conversation.section === "channels")
        .reduce((total, conversation) => total + conversation.unreadCount, 0),
      junk: 0,
      trash: 0,
      recent: conversations.reduce(
        (total, conversation) =>
          conversation.section === "junk" || conversation.section === "trash"
            ? total
            : total + conversation.unreadCount,
        0
      )
    }),
    [conversations]
  );
  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return conversations.filter((conversation) => {
      const inSection = section === "recent" || conversation.section === section;
      const matches =
        normalizedQuery.length === 0 ||
        conversation.name.toLocaleLowerCase().includes(normalizedQuery) ||
        conversation.address?.toLocaleLowerCase().includes(normalizedQuery) ||
        conversation.preview.toLocaleLowerCase().includes(normalizedQuery);
      return inSection && matches;
    });
  }, [conversations, query, section]);

  function chooseSection(next: Section) {
    setSection(next);
    setMobilePane("list");
    setShowMobileMore(false);
    const first = conversations.find(
      (conversation) => next === "recent" || conversation.section === next
    );
    if (first) setSelectedId(first.id);
  }

  function chooseConversation(conversation: ConversationSummary) {
    setSelectedId(conversation.id);
    setView("stream");
    setShowOriginal(false);
    setMobilePane("conversation");
    setActionError(null);
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.has("conversation")) {
      currentUrl.searchParams.set("conversation", conversation.id);
      window.history.replaceState(null, "", currentUrl);
    }
    if (conversation.unreadCount > 0) {
      void markConversationRead(conversation.id);
    }
  }

  function openConversationMenu(
    conversation: ConversationSummary,
    event: ReactMouseEvent<HTMLButtonElement>
  ) {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const requestedX = event.clientX || bounds.left + Math.min(96, bounds.width / 2);
    const requestedY = event.clientY || bounds.top + Math.min(36, bounds.height / 2);
    setConversationMenu({
      conversation,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 208)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 154))
    });
  }

  function showToast(message: string) {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2_600);
  }

  async function shareConversation(conversation: ConversationSummary) {
    setConversationMenu(null);
    const shareUrl = new URL(window.location.href);
    shareUrl.search = "";
    shareUrl.hash = "";
    shareUrl.searchParams.set("conversation", conversation.id);

    try {
      await copyToClipboard(shareUrl.toString());
      showToast("Link copied to clipboard");
    } catch {
      showToast("Couldn’t copy the link");
    }
  }

  async function renameConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameDialog || renaming) return;
    const name = renameDialog.name.trim();
    if (!name) {
      setRenameError("Enter a name for this chat.");
      return;
    }

    setRenaming(true);
    setRenameError(null);
    try {
      const detail = await mailboxClient.renameConversation(
        renameDialog.conversation.id,
        name
      );
      setIndexState((current) => current.kind === "loaded"
        ? {
            kind: "loaded",
            data: {
              ...current.data,
              conversations: current.data.conversations.map((conversation) =>
                conversation.id === detail.id
                  ? { ...conversation, name: detail.name, initials: detail.initials }
                  : conversation
              )
            }
          }
        : current);
      setDetailState((current) =>
        current.kind === "loaded" && current.data.id === detail.id
          ? { kind: "loaded", data: detail }
          : current
      );
      setRenameDialog(null);
      showToast("Chat renamed");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Chat rename failed");
    } finally {
      setRenaming(false);
    }
  }

  async function reloadMailboxView() {
    const nextIndex = await mailboxClient.loadIndex();
    setIndexState({ kind: "loaded", data: nextIndex });

    const currentId = selectedIdRef.current;
    if (!currentId || !nextIndex.conversations.some((item) => item.id === currentId)) {
      return;
    }
    setDetailState({
      kind: "loaded",
      data: await mailboxClient.loadDetail(currentId)
    });
  }

  async function refreshMailbox() {
    if (refreshing || syncStatus?.state === "syncing") {
      setPullDistance(0);
      pullStartYRef.current = null;
      return;
    }
    setRefreshing(true);
    setSyncStatus((current) =>
      current ? { ...current, state: "syncing", lastError: null } : current
    );
    try {
      const status = await mailboxClient.refresh();
      setSyncStatus(status);
      lastObservedSyncRef.current = status.lastSuccessfulAt;
      await reloadMailboxView();
    } catch {
      setSyncStatus(await mailboxClient.getSyncStatus().catch(() => syncStatus));
    } finally {
      setRefreshing(false);
      setPullDistance(0);
      pullStartYRef.current = null;
    }
  }

  function beginPull(event: TouchEvent<HTMLDivElement>) {
    if (
      window.matchMedia("(min-width: 761px)").matches ||
      event.currentTarget.scrollTop > 0 ||
      refreshing ||
      syncStatus?.state === "syncing"
    ) {
      pullStartYRef.current = null;
      return;
    }
    pullStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function updatePull(event: TouchEvent<HTMLDivElement>) {
    const startY = pullStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    const distance = currentY - startY;
    if (distance <= 0) {
      setPullDistance(0);
      return;
    }
    event.preventDefault();
    setPullDistance(Math.min(76, distance * 0.48));
  }

  function finishPull() {
    if (pullDistance >= 52) {
      void refreshMailbox();
    } else {
      setPullDistance(0);
      pullStartYRef.current = null;
    }
  }

  async function markConversationRead(conversationId: string) {
    setIndexState((current) =>
      current.kind === "loaded"
        ? {
            kind: "loaded",
            data: {
              ...current.data,
              conversations: current.data.conversations.map((conversation) =>
                conversation.id === conversationId
                  ? { ...conversation, unreadCount: 0 }
                  : conversation
              )
            }
          }
        : current
    );
    setDetailState((current) =>
      current.kind === "loaded" && current.data.id === conversationId
        ? {
            kind: "loaded",
            data: {
              ...current.data,
              unreadCount: 0,
              messages: current.data.messages.map((message) =>
                message.direction === "incoming"
                  ? { ...message, isRead: true }
                  : message
              )
            }
          }
        : current
    );

    try {
      const detail = await mailboxClient.markConversationRead(conversationId);
      setDetailState((current) =>
        current.kind === "loaded" && current.data.id === conversationId
          ? { kind: "loaded", data: detail }
          : current
      );
    } catch {
      await reloadMailboxView().catch(() => undefined);
    }
  }

  async function markConversationUnread(conversationId: string) {
    setIndexState((current) =>
      current.kind === "loaded"
        ? {
            kind: "loaded",
            data: {
              ...current.data,
              conversations: current.data.conversations.map((conversation) =>
                conversation.id === conversationId
                  ? { ...conversation, unreadCount: Math.max(1, conversation.unreadCount) }
                  : conversation
              )
            }
          }
        : current
    );
    setDetailState((current) => {
      if (current.kind !== "loaded" || current.data.id !== conversationId) {
        return current;
      }
      const latestIncoming = [...current.data.messages]
        .reverse()
        .find((message) => message.direction === "incoming");
      return {
        kind: "loaded",
        data: {
          ...current.data,
          unreadCount: Math.max(1, current.data.unreadCount),
          messages: current.data.messages.map((message) =>
            message.id === latestIncoming?.id ? { ...message, isRead: false } : message
          )
        }
      };
    });

    try {
      const detail = await mailboxClient.markConversationUnread(conversationId);
      setIndexState((current) =>
        current.kind === "loaded"
          ? {
              kind: "loaded",
              data: {
                ...current.data,
                conversations: current.data.conversations.map((conversation) =>
                  conversation.id === conversationId
                    ? { ...conversation, unreadCount: detail.unreadCount }
                    : conversation
                )
              }
            }
          : current
      );
      setDetailState((current) =>
        current.kind === "loaded" && current.data.id === conversationId
          ? { kind: "loaded", data: detail }
          : current
      );
    } catch {
      await reloadMailboxView().catch(() => undefined);
    }
  }

  async function runConversationAction(action: ConversationAction) {
    if (!selectedId || conversationAction) return;
    setConversationAction(action);
    setActionError(null);

    try {
      const detail = await mailboxClient.runConversationAction(selectedId, action);
      const nextIndex = await mailboxClient.loadIndex();
      setDetailState({ kind: "loaded", data: detail });
      setIndexState({ kind: "loaded", data: nextIndex });
      setSelectedId(detail.id);
      setSection(detail.section);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Conversation update failed");
    } finally {
      setConversationAction(null);
    }
  }

  async function askBoxie() {
    const question = assistantQuestion.trim();
    if (
      !selectedId ||
      !question ||
      assistantSubmitting ||
      assistantStatus?.available !== true
    ) {
      return;
    }

    const optimisticId = `pending-${Date.now()}`;
    const optimisticTurn: PrivateAssistantTurn = {
      id: optimisticId,
      conversationId: selectedId,
      provider: "cursor-acp",
      modelId: assistantStatus.modelId,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
      errorCode: null,
      messages: [
        {
          id: `${optimisticId}-question`,
          role: "user",
          content: question,
          evidenceMessageIds: [],
          createdAt: new Date().toISOString()
        }
      ]
    };
    setAssistantSubmitting(true);
    setAssistantError(null);
    setAssistantQuestion("");
    setAssistantTurnsState((current) => ({
      kind: "loaded",
      turns: [
        ...(current.kind === "loaded" ? current.turns : []),
        optimisticTurn
      ]
    }));

    try {
      const completed = await mailboxClient.askBoxie(selectedId, question);
      setAssistantTurnsState((current) => ({
        kind: "loaded",
        turns: (current.kind === "loaded" ? current.turns : []).map((turn) =>
          turn.id === optimisticId ? completed : turn
        )
      }));
    } catch (error) {
      if (selectedIdRef.current === selectedId) {
        setAssistantTurnsState((current) => ({
          kind: "loaded",
          turns: (current.kind === "loaded" ? current.turns : []).map((turn) =>
            turn.id === optimisticId
              ? {
                  ...turn,
                  status: "failed",
                  completedAt: new Date().toISOString(),
                  errorCode: "request_failed"
                }
              : turn
          )
        }));
        setAssistantError(
          error instanceof Error ? error.message : "Boxie couldn't answer privately"
        );
      }
    } finally {
      setAssistantSubmitting(false);
    }
  }

  return (
    <main className={`app-shell ${desktopRailExpanded ? "rail-expanded" : "rail-collapsed"}`}>
      <aside className="navigation-rail" aria-label="Mailbox views">
        <button
          type="button"
          className="rail-brand"
          aria-label={desktopRailExpanded ? "Collapse navigation" : "Expand navigation"}
          aria-expanded={desktopRailExpanded}
          onClick={() => setDesktopRailExpanded((current) => !current)}
          title={desktopRailExpanded ? "Collapse navigation" : "Expand navigation"}
        >
          <img src="/brand/boxie-icon.png" alt="" />
          <span className="rail-brand-name">Boxie</span>
          {desktopRailExpanded
            ? <ChevronLeft className="rail-brand-chevron" aria-hidden="true" />
            : <ChevronRight className="rail-brand-chevron" aria-hidden="true" />}
        </button>
        <nav>
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="rail-button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => chooseSection(id)}
              title={label}
            >
              <Icon aria-hidden="true" />
              <span className="rail-label">{label}</span>
              {notificationCounts[id] > 0 && <span className="rail-count">{notificationCounts[id]}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-state" title="Mailbox access is read-only">
          <LockKeyhole aria-hidden="true" />
          <span>Outlook read-only</span>
        </div>
        {syncStatus?.encryptedReplica && (
          <div
            className={`rail-state replica-state ${syncStatus.encryptedReplica.state === "error" ? "replica-error" : ""}`}
            title={syncStatus.encryptedReplica.lastError ?? "Mailbox content is encrypted before cloud backup"}
          >
            <ShieldCheck aria-hidden="true" />
            <span>
              {syncStatus.encryptedReplica.state === "syncing"
                ? "Encrypting backup"
                : syncStatus.encryptedReplica.state === "error" || syncStatus.encryptedReplica.pendingCount > 0
                  ? `Backup pending (${syncStatus.encryptedReplica.pendingCount})`
                  : "Encrypted backup"}
            </span>
          </div>
        )}
      </aside>

      <section className={`conversation-list ${mobilePane === "conversation" ? "mobile-hidden" : ""}`}>
        <header className="list-header">
          <div className="brand-line">
            <div>
              <h1>Boxie</h1>
              <button
                type="button"
                className="account-selector"
                onClick={() => window.location.assign("/?onboarding=1")}
                title="Review or switch the connected account"
              >
                Personal Outlook <ChevronDown aria-hidden="true" />
              </button>
            </div>
            <div className="brand-actions">
              <a href="/feedback">Feedback</a>
              {mailboxClient.kind === "browser" && <a href="/?cloudVault=1">Cloud sync (optional)</a>}
              <a href="/delete-account" title="Delete your Boxie account" aria-label="Delete your Boxie account"><Trash2 size={18} /></a>
              <button
                type="button"
                className="sync-button"
                disabled={refreshing || syncStatus?.state === "syncing" || syncStatus?.enabled === false}
                onClick={() => void refreshMailbox()}
                title="Check Outlook for new messages"
              >
                <RefreshCw
                  className={refreshing || syncStatus?.state === "syncing" ? "spin" : undefined}
                  aria-hidden="true"
                />
                Refresh
              </button>
            </div>
          </div>
          <label className="search-field">
            <Search aria-hidden="true" />
            <span className="sr-only">Search conversations</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations"
            />
          </label>
        </header>

        <div className="list-label">
          <strong>{sections.find((item) => item.id === section)?.label}</strong>
          <span className={syncStatus?.state === "error" ? "sync-status-error" : undefined}>
            {visibleConversations.length} conversations · {formatSyncStatus(syncStatus, clock)}
          </span>
        </div>

        <div
          className="conversation-rows"
          onTouchStart={beginPull}
          onTouchMove={updatePull}
          onTouchEnd={finishPull}
          onTouchCancel={finishPull}
        >
          <div
            className={`pull-to-refresh ${refreshing ? "is-refreshing" : ""}`}
            style={{ height: `${refreshing ? 36 : pullDistance}px` }}
            aria-hidden={pullDistance === 0 && !refreshing}
          >
            <RefreshCw className={refreshing ? "spin" : undefined} aria-hidden="true" />
            <span>
              {refreshing
                ? "Checking Outlook…"
                : pullDistance >= 52
                  ? "Release to refresh"
                  : "Pull to refresh"}
            </span>
          </div>
          {indexState.kind === "loading" && <ConversationListSkeleton />}
          {indexState.kind === "error" && (
            <InlineError title="Boxie can’t load the local mailbox" message={indexState.message} />
          )}
          {indexState.kind === "loaded" && visibleConversations.length === 0 && (
            <EmptyList section={section} hasMail={conversations.length > 0} />
          )}
          {visibleConversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedId}
              menuOpen={conversationMenu?.conversation.id === conversation.id}
              onSelect={() => chooseConversation(conversation)}
              onOpenContextMenu={
                conversation.isBoxie
                  ? undefined
                  : (event) => openConversationMenu(conversation, event)
              }
            />
          ))}
        </div>

        {index && (
          <footer className="coverage-footer">
            <ShieldCheck aria-hidden="true" />
            <span>
              Tracking since {formatCoverageDate(index.coverage.activatedAt)} · older mail stays in Outlook
            </span>
          </footer>
        )}

        <nav className="mobile-navigation" aria-label="Mailbox views">
          {showMobileMore && (
            <div className="mobile-more-menu">
              {sections
                .filter(({ id }) => id === "recent" || id === "trash")
                .map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" onClick={() => chooseSection(id)}>
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
            </div>
          )}
          {mobilePrimarySections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => chooseSection(id)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {notificationCounts[id] > 0 && <b>{notificationCounts[id]}</b>}
            </button>
          ))}
          <button
            type="button"
            aria-current={section === "recent" || section === "trash" ? "page" : undefined}
            aria-expanded={showMobileMore}
            onClick={() => setShowMobileMore((current) => !current)}
          >
            <Ellipsis aria-hidden="true" />
            <span>More</span>
          </button>
        </nav>
      </section>

      <section className={`conversation-pane ${mobilePane === "list" ? "mobile-hidden" : ""}`}>
        {detailState.kind === "loaded" ? (
          <ConversationView
            conversation={detailState.data}
            view={view}
            setView={setView}
            selectedTopicId={selectedTopicId}
            setSelectedTopicId={setSelectedTopicId}
            showOriginal={showOriginal}
            setShowOriginal={setShowOriginal}
            action={conversationAction}
            actionError={actionError}
            onAction={runConversationAction}
            moderationPolicy={moderationPolicy}
            assistantStatus={assistantStatus}
            assistantTurnsState={assistantTurnsState}
            assistantQuestion={assistantQuestion}
            setAssistantQuestion={setAssistantQuestion}
            assistantSubmitting={assistantSubmitting}
            assistantError={assistantError}
            onAskBoxie={() => void askBoxie()}
            onBack={() => setMobilePane("list")}
          />
        ) : detailState.kind === "error" ? (
          <InlineError title="This conversation couldn’t be opened" message={detailState.message} />
        ) : detailState.kind === "loading" ? (
          <ConversationSkeleton onBack={() => setMobilePane("list")} />
        ) : (
          <WelcomeEmpty onBack={() => setMobilePane("list")} />
        )}
      </section>

      {conversationMenu && (
        <div
          ref={conversationMenuRef}
          className="conversation-context-menu"
          role="menu"
          aria-label={`Actions for ${conversationMenu.conversation.name}`}
          style={{ left: conversationMenu.x, top: conversationMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenameDialog({
                conversation: conversationMenu.conversation,
                name: conversationMenu.conversation.name
              });
              setRenameError(null);
              setConversationMenu(null);
            }}
          >
            <PencilLine aria-hidden="true" />
            <span>Rename chat</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const conversation = conversationMenu.conversation;
              setConversationMenu(null);
              if (conversation.unreadCount > 0) {
                void markConversationRead(conversation.id);
              } else {
                void markConversationUnread(conversation.id);
              }
            }}
          >
            {conversationMenu.conversation.unreadCount > 0
              ? <MailOpen aria-hidden="true" />
              : <Mail aria-hidden="true" />}
            <span>
              {conversationMenu.conversation.unreadCount > 0
                ? "Mark as read"
                : "Mark as unread"}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void shareConversation(conversationMenu.conversation)}
          >
            <Share2 aria-hidden="true" />
            <span>Share</span>
          </button>
        </div>
      )}

      {renameDialog && (
        <div
          className="rename-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renaming) {
              setRenameDialog(null);
            }
          }}
        >
          <form
            className="rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-dialog-title"
            onSubmit={(event) => void renameConversation(event)}
          >
            <span className="rename-dialog-kicker">Conversation identity</span>
            <h2 id="rename-dialog-title">Rename chat</h2>
            <p>This changes only how the conversation appears in Boxie.</p>
            <label>
              <span>Chat name</span>
              <input
                autoFocus
                maxLength={120}
                value={renameDialog.name}
                onChange={(event) => {
                  setRenameDialog((current) => current
                    ? { ...current, name: event.target.value }
                    : current);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !renaming) {
                    setRenameDialog(null);
                  }
                }}
              />
            </label>
            {renameError && <div className="rename-dialog-error" role="alert">{renameError}</div>}
            <div className="rename-dialog-actions">
              <button type="button" disabled={renaming} onClick={() => setRenameDialog(null)}>Cancel</button>
              <button type="submit" disabled={renaming || renameDialog.name.trim().length === 0}>
                {renaming ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                Save name
              </button>
            </div>
          </form>
        </div>
      )}

      {toastMessage && (
        <div className="boxie-toast" role="status" aria-live="polite">
          <Check aria-hidden="true" />
          <span>{toastMessage}</span>
        </div>
      )}
    </main>
  );
}

function ConversationRow({ conversation, selected, menuOpen, onSelect, onOpenContextMenu }: {
  conversation: ConversationSummary;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onOpenContextMenu: ((event: ReactMouseEvent<HTMLButtonElement>) => void) | undefined;
}) {
  return (
    <button
      type="button"
      className={`conversation-row ${conversation.isBoxie ? "conversation-row-boxie" : ""}`}
      aria-pressed={selected}
      data-menu-open={menuOpen || undefined}
      onClick={onSelect}
      onContextMenu={onOpenContextMenu}
    >
      <Avatar conversation={conversation} />
      <span className="row-copy">
        <span className="row-title">
          <strong title={conversation.name}>{conversation.name}</strong>
          {conversation.isBoxie && <Sparkles aria-label="Boxie assistant" />}
          {conversation.kind === "group" && <UsersRound aria-label="Group" />}
          {conversation.kind === "channel" && <Hash aria-label="Automated sender" />}
        </span>
        <span className="row-preview">{conversation.preview || "No readable preview"}</span>
      </span>
      <span className="row-meta">
        <time dateTime={conversation.lastMessageAt}>{formatListTime(conversation.lastMessageAt)}</time>
        {conversation.unreadCount > 0 && <b>{conversation.unreadCount}</b>}
      </span>
    </button>
  );
}

function ConversationView({
  conversation,
  view,
  setView,
  selectedTopicId,
  setSelectedTopicId,
  showOriginal,
  setShowOriginal,
  action,
  actionError,
  onAction,
  moderationPolicy,
  assistantStatus,
  assistantTurnsState,
  assistantQuestion,
  setAssistantQuestion,
  assistantSubmitting,
  assistantError,
  onAskBoxie,
  onBack
}: {
  conversation: ConversationDetail;
  view: ViewMode;
  setView: (view: ViewMode) => void;
  selectedTopicId: string | null;
  setSelectedTopicId: (id: string) => void;
  showOriginal: boolean;
  setShowOriginal: (show: boolean) => void;
  action: ConversationAction | null;
  actionError: string | null;
  onAction: (action: ConversationAction) => void;
  moderationPolicy: ModerationPolicy;
  assistantStatus: AssistantStatus | null;
  assistantTurnsState: AssistantTurnsState;
  assistantQuestion: string;
  setAssistantQuestion: (question: string) => void;
  assistantSubmitting: boolean;
  assistantError: string | null;
  onAskBoxie: () => void;
  onBack: () => void;
}) {
  const assistantEndRef = useRef<HTMLDivElement | null>(null);
  const assistantTurns =
    assistantTurnsState.kind === "loaded" ? assistantTurnsState.turns : [];
  useEffect(() => {
    if (assistantTurns.length > 0 || assistantSubmitting) {
      assistantEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [assistantTurns.length, assistantSubmitting]);
  const topic =
    conversation.topics.find((candidate) => candidate.id === selectedTopicId) ??
    conversation.topics[0];
  const visibleMessages =
    view === "topics" && topic
      ? conversation.messages.filter((message) => message.topicId === topic.id)
      : conversation.messages;
  const subtitle =
    conversation.isBoxie
      ? "Your private email assistant"
      : conversation.moderation === "trash"
      ? "In Trash"
      : conversation.moderation === "junk"
        ? "Blocked sender"
        : conversation.section === "requests"
          ? "Unverified sender"
          : "Active conversation";

  return (
    <>
      <header className="conversation-header">
        <button type="button" className="back-button" aria-label="Back to conversations" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <Avatar conversation={conversation} large />
        <div className="conversation-title">
          <h2 title={conversation.name}>{conversation.name}</h2>
          <p>
            {subtitle}
            {conversation.address ? ` · ${conversation.address}` : ""}
          </p>
        </div>
        {!conversation.isBoxie && <div className="conversation-actions">
          {conversation.moderation === "trash" ? (
            <button
              type="button"
              className="conversation-action conversation-action-restore"
              disabled={action !== null}
              onClick={() => onAction("restore")}
              title="Restore this conversation"
            >
              {action === "restore" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Undo2 aria-hidden="true" />}
              <span>Restore</span>
            </button>
          ) : (
            <>
              {conversation.address && (
                <button
                  type="button"
                  className="conversation-action conversation-action-junk"
                  disabled={action !== null}
                  onClick={() => onAction(conversation.moderation === "junk" ? "not_junk" : "junk")}
                  title={conversation.moderation === "junk" ? "Allow future mail from this sender" : "Block this sender and move future mail to Junk"}
                >
                  {action === "junk" || action === "not_junk" ? <LoaderCircle className="spin" aria-hidden="true" /> : <ShieldBan aria-hidden="true" />}
                  <span>{conversation.moderation === "junk" ? "Not junk" : "Junk"}</span>
                </button>
              )}
              <button
                type="button"
                className="conversation-action conversation-action-trash"
                disabled={action !== null}
                onClick={() => onAction("trash")}
                title="Move this conversation to Trash"
              >
                {action === "trash" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                <span>Trash</span>
              </button>
            </>
          )}
        </div>}
        {conversation.isBoxie ? (
          <span className="boxie-private-badge"><Sparkles aria-hidden="true" />Private to you</span>
        ) : (
          <span className="read-only-badge"><LockKeyhole aria-hidden="true" />Outlook read-only</span>
        )}
      </header>

      {actionError && conversation.section !== "requests" && (
        <div className="conversation-action-error" role="alert">{actionError}</div>
      )}

      {conversation.section === "requests" && (
        <div className="request-banner">
          <ShieldCheck aria-hidden="true" />
          <div className="request-copy">
            <strong>
              {conversation.admission === "kept_request"
                ? "This conversation is staying in Requests"
                : "Boxie hasn’t verified an earlier relationship yet"}
            </strong>
            <p>{conversation.admissionReason}</p>
            {actionError && <p className="request-error" role="alert">{actionError}</p>}
          </div>
          <div className="request-actions">
            {conversation.canCheckHistory && (
              <button
                type="button"
                className="request-button request-button-secondary"
                disabled={action !== null}
                onClick={() => onAction("check_history")}
              >
                {action === "check_history" && <LoaderCircle className="spin" aria-hidden="true" />}
                Check earlier mail
              </button>
            )}
            <button
              type="button"
              className="request-button request-button-secondary"
              disabled={action !== null || conversation.admission === "kept_request"}
              onClick={() => onAction("keep_request")}
            >
              {action === "keep_request" && <LoaderCircle className="spin" aria-hidden="true" />}
              {conversation.admission === "kept_request" ? "Kept in Requests" : "Keep in Requests"}
            </button>
            <button
              type="button"
              className="request-button request-button-primary"
              disabled={action !== null}
              onClick={() => onAction("accept")}
            >
              {action === "accept" && <LoaderCircle className="spin" aria-hidden="true" />}
              Accept
            </button>
          </div>
        </div>
      )}

      {conversation.moderation === "junk" && (
        <div className="moderation-banner moderation-banner-junk">
          <ShieldBan aria-hidden="true" />
          <div>
            <strong>Future messages from this sender stay quiet in Junk</strong>
            <p>After {moderationPolicy.junkRetentionDays} days they move to Trash. Outlook itself is unchanged.</p>
          </div>
        </div>
      )}

      {conversation.moderation === "trash" && (
        <div className="moderation-banner moderation-banner-trash">
          <Trash2 aria-hidden="true" />
          <div>
            <strong>This is the last Boxie recovery layer</strong>
            <p>The local copy is removed after {moderationPolicy.trashRetentionDays} days. The original remains in Outlook.</p>
          </div>
        </div>
      )}

      {!conversation.isBoxie && <div className="view-toolbar">
        <div className="view-switch" role="tablist" aria-label="Conversation view">
          <button type="button" role="tab" aria-selected={view === "stream"} onClick={() => setView("stream")}>Stream</button>
          <button type="button" role="tab" aria-selected={view === "topics"} onClick={() => setView("topics")}>Topics <span>{conversation.topicCount}</span></button>
        </div>
        <button type="button" className="original-toggle" aria-pressed={showOriginal} onClick={() => setShowOriginal(!showOriginal)}>
          <Mail aria-hidden="true" />
          {showOriginal ? "Cleaned view" : "Original mode"}
        </button>
      </div>}

      <div className={`conversation-content ${view === "topics" && !conversation.isBoxie ? "topics-layout" : ""} ${conversation.isBoxie ? "boxie-guide-content" : ""}`}>
        {view === "topics" && !conversation.isBoxie && (
          <aside className="topic-list" aria-label="Topics">
            <header><strong>Topics</strong><span>Provider email threads</span></header>
            {conversation.topics.map((candidate) => (
              <button key={candidate.id} type="button" aria-pressed={topic?.id === candidate.id} onClick={() => setSelectedTopicId(candidate.id)}>
                <span className="topic-icon"><Hash aria-hidden="true" /></span>
                <span>
                  <strong>{candidate.title}</strong>
                  <small>{candidate.messageCount} {candidate.messageCount === 1 ? "message" : "messages"}</small>
                </span>
                <time dateTime={candidate.lastMessageAt}>{formatListTime(candidate.lastMessageAt)}</time>
              </button>
            ))}
          </aside>
        )}

        <div className="message-scroll">
          <div className="message-stage">
            <div className="day-divider"><span />{conversation.isBoxie ? "Meet Boxie" : "Since Boxie started"}<span /></div>
            {visibleMessages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                showOriginal={showOriginal}
                isBoxie={conversation.isBoxie === true}
              />
            ))}
            {conversation.isBoxie && assistantTurns.length === 0 && assistantTurnsState.kind !== "loading" && (
              <div className="boxie-starters" aria-label="Suggested questions">
                {["What can you do?", "How do you protect my email?", "What are we building next?"].map((prompt) => (
                  <button key={prompt} type="button" onClick={() => setAssistantQuestion(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            {!conversation.isBoxie && (assistantTurns.length > 0 || assistantTurnsState.kind === "loading") && (
              <div className="private-thread-divider">
                <span />
                <Sparkles aria-hidden="true" />
                <strong>Private with Boxie</strong>
                <span />
              </div>
            )}
            {assistantTurnsState.kind === "loading" && (
              <div className="private-thread-loading">
                <LoaderCircle className="spin" aria-hidden="true" />
                Loading your private conversation…
              </div>
            )}
            {assistantTurns.map((turn) => (
              <PrivateAssistantExchange key={turn.id} turn={turn} />
            ))}
            <div ref={assistantEndRef} />
          </div>
        </div>
      </div>

      <form
        className="boxie-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onAskBoxie();
        }}
      >
        <div className="boxie-composer-identity" aria-hidden="true">
          <img src="/brand/boxie-icon.png" alt="" />
        </div>
        <div className="boxie-composer-main">
          <div className="boxie-composer-heading">
            <strong><Sparkles aria-hidden="true" />Ask Boxie privately</strong>
            <span>{assistantStatus?.modelName ?? "Cursor"} · drag the lower corner to resize</span>
          </div>
          <textarea
            value={assistantQuestion}
            maxLength={2_000}
            rows={3}
            disabled={assistantStatus?.available !== true || assistantSubmitting}
            onChange={(event) => setAssistantQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onAskBoxie();
              }
            }}
            placeholder={
              assistantStatus?.available === false
                ? "Cursor is unavailable"
                : "Ask about this conversation…"
            }
            aria-label="Private question for Boxie"
            aria-describedby="boxie-composer-safety"
          />
          <div className="boxie-composer-meta" id="boxie-composer-safety">
            <span><LockKeyhole aria-hidden="true" />Only you can see this</span>
            <span><BellOff aria-hidden="true" />Never sent as email</span>
            {assistantError && <b role="alert">{assistantError}</b>}
          </div>
        </div>
        <button
          type="submit"
          className="boxie-send"
          disabled={
            assistantStatus?.available !== true ||
            assistantSubmitting ||
            assistantQuestion.trim().length === 0
          }
          title="Ask Boxie privately"
        >
          {assistantSubmitting
            ? <LoaderCircle className="spin" aria-hidden="true" />
            : <Send aria-hidden="true" />}
          <span>{assistantSubmitting ? "Thinking" : "Ask"}</span>
        </button>
      </form>
    </>
  );
}

function PrivateAssistantExchange({ turn }: { turn: PrivateAssistantTurn }) {
  const question = turn.messages.find((message) => message.role === "user");
  const answer = turn.messages.find((message) => message.role === "assistant");
  return (
    <section className="private-exchange" aria-label="Private conversation with Boxie">
      {question && (
        <article className="private-message private-message-user">
          <header>You → Boxie <LockKeyhole aria-label="Private" /></header>
          <p>{question.content}</p>
        </article>
      )}
      <article className={`private-message private-message-boxie private-message-${turn.status}`}>
        <header>
          <span><img src="/brand/boxie-icon.png" alt="" />Boxie</span>
          <b>Private</b>
        </header>
        {turn.status === "pending" ? (
          <p className="private-thinking"><LoaderCircle className="spin" aria-hidden="true" />Reading this conversation…</p>
        ) : turn.status === "failed" ? (
          <p className="private-failure">I couldn’t complete that question. Nothing was sent.</p>
        ) : (
          <>
            <p>{answer?.content}</p>
            {answer && answer.evidenceMessageIds.length > 0 && (
              <footer>
                <ShieldCheck aria-hidden="true" />
                {answer.evidenceMessageIds.length} source {answer.evidenceMessageIds.length === 1 ? "message" : "messages"}
              </footer>
            )}
          </>
        )}
      </article>
    </section>
  );
}

function MessageBubble({
  message,
  showOriginal,
  isBoxie = false
}: {
  message: ProjectedMessage;
  showOriginal: boolean;
  isBoxie?: boolean;
}) {
  const outgoing = message.direction === "outgoing";
  const text = showOriginal ? message.originalText : message.cleanedText;
  const body = showOriginal ? message.originalBody : message.cleanedBody;
  const addressed = message.recipients.filter(
    (recipient) => recipient.kind === "to" || recipient.kind === "cc"
  );

  return (
    <article className={`message ${outgoing ? "message-outgoing" : "message-incoming"} ${isBoxie ? "boxie-welcome-message" : ""}`}>
      {!outgoing && !isBoxie && <strong className="message-author">{message.authorName}</strong>}
      <div className="message-bubble">
        <header>
          <span>
            {isBoxie && <img src="/brand/boxie-icon.png" alt="" />}
            {isBoxie ? "Boxie" : showOriginal ? "Original email" : message.subject}
          </span>
          {isBoxie && <b>Welcome</b>}
          {message.isRead === false && <b>Unread</b>}
        </header>
        <SafeMessageBody body={body} fallbackText={text} />
        {!isBoxie && <footer>
          <time dateTime={message.occurredAt}>{formatMessageTime(message.occurredAt)}</time>
          {outgoing && <Check aria-label="Sent" />}
        </footer>}
        {!isBoxie && <details>
          <summary>{addressed.length} addressed {addressed.length === 1 ? "recipient" : "recipients"}</summary>
          <dl>
            {addressed.map((recipient, index) => (
              <div key={`${recipient.kind}-${recipient.address}-${index}`}>
                <dt>{recipient.kind.toUpperCase()}</dt>
                <dd>{recipient.name ? `${recipient.name} · ` : ""}{recipient.address}</dd>
              </div>
            ))}
          </dl>
        </details>}
        {message.webLink && (
          <a href={message.webLink} target="_blank" rel="noreferrer">
            Open in Outlook <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
    </article>
  );
}

function Avatar({ conversation, large = false }: { conversation: ConversationSummary; large?: boolean }) {
  if (conversation.isBoxie) {
    return (
      <span
        className={`avatar avatar-boxie ${large ? "avatar-large" : ""}`}
        aria-hidden="true"
      >
        <img src="/brand/boxie-avatar.png" alt="" />
      </span>
    );
  }
  return (
    <span
      className={`avatar ${large ? "avatar-large" : ""}`}
      style={{ "--avatar-hue": avatarHue(conversation.avatarSeed) } as CSSProperties}
      aria-hidden="true"
    >
      {conversation.initials}
    </span>
  );
}

function EmptyList({ section, hasMail }: { section: Section; hasMail: boolean }) {
  const message = hasMail
    ? section === "chats"
      ? "No admitted conversations yet. New senders stay in Requests until Boxie can verify the relationship."
      : section === "channels"
        ? "No admitted service channels yet. Automated first-time senders remain in Requests."
        : section === "junk"
          ? "No blocked senders. Mark a conversation as Junk and future messages will stay quiet here."
          : section === "trash"
            ? "Trash is empty. Removed conversations remain recoverable here before local retention expires."
        : "Nothing matches this view."
    : "No post-activation messages are stored yet. Run a sync after new mail arrives.";
  return (
    <div className="empty-list">
      <img src="/brand/boxie-icon.png" alt="" />
      <strong>Quiet here</strong>
      <p>{message}</p>
    </div>
  );
}

function WelcomeEmpty({ onBack }: { onBack: () => void }) {
  return (
    <div className="welcome-empty">
      <button type="button" className="back-button" onClick={onBack} aria-label="Back to conversations"><ArrowLeft aria-hidden="true" /></button>
      <img src="/brand/boxie-avatar.png" alt="Boxie" />
      <h2>Your mail is becoming conversations</h2>
      <p>Select a sender to inspect the post-activation stream and its original source.</p>
    </div>
  );
}

function ConversationListSkeleton() {
  return <div className="list-skeleton" aria-label="Loading conversations">{[1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function ConversationSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="conversation-skeleton" aria-label="Loading conversation">
      <button type="button" className="back-button" onClick={onBack} aria-label="Back to conversations"><ArrowLeft /></button>
      <span /><span /><span />
    </div>
  );
}

function InlineError({ title, message }: { title: string; message: string }) {
  return <div className="inline-error"><strong>{title}</strong><p>{message}</p></div>;
}

function avatarHue(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return String(hash % 360);
}

function formatListTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatSyncStatus(
  status: MailboxSyncStatus | null,
  now: number
): string {
  if (!status) return "Checking sync…";
  if (status.state === "syncing") return "Syncing…";
  if (status.state === "error") return "Sync issue";
  if (!status.enabled) return "Sync unavailable";
  if (!status.lastSuccessfulAt) return "Waiting for first sync";

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(status.lastSuccessfulAt).getTime()) / 1_000)
  );
  if (elapsedSeconds < 15) return "Synced just now";
  if (elapsedSeconds < 60) return `Synced ${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `Synced ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `Synced ${elapsedHours}h ago`;
}

function formatCoverageDate(value: string | null): string {
  if (!value) return "not connected";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browsers that expose the API but deny the operation.
    }
  }

  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}
