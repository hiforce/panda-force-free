import { reportDiagnostic } from "../../shared/diagnostics.js";
import { threadLastActivityAt } from "../conversation-policy.js";
import { createSerialPoller } from "../serial-poller.js";
import { findElements } from "./../dom.js";

// Owns summary and active-history polling, request generations and snapshot application.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "sessions" | "state" | "workspacePreparation" | "$", "transport" | "status" | "repositories" | "models" | "queue" | "history" | "timing" | "timeline" | "composer" | "viewport", "synchronization">} options */
export function assembleSynchronization({
  transportPort,
  viewUpdates,
  sessions,
  state,
  workspacePreparation,
  $,
  statusPort,
  repositoriesPort,
  modelsPort,
  queuePort,
  historyPort,
  timingPort,
  timelinePort,
  composerPort,
  viewportPort,
}) {
  let threadListHasFreshData = false;
  const ACTIVE_THREAD_SYNC_ACTIVE_MS = 800,
    ACTIVE_THREAD_SYNC_IDLE_MS = 2400,
    THREAD_LIST_POLL_MS = 3000;
  let activeThreadSyncSignature = "",
    threadListSignature = "";
  const activeThreadPoller = createSerialPoller({
    read: (current) => syncActiveThreadRead(current),
    enabled: () => Boolean(state.active && state.connected),
    interval: ACTIVE_THREAD_SYNC_IDLE_MS,
    hiddenInterval: 6000,
  });
  const threadListPoller = createSerialPoller({
    read: async (current) => {
      try {
        const result = await transportPort.rpc("thread/list", {
          limit: 50,
          sortKey: "recency_at",
          sortDirection: "desc",
        });
        if (current()) applyThreadSummaries(result.data || []);
      } catch (error) {
        reportDiagnostic("session-list", error);
      } finally {
        if (current()) statusPort.refreshThreadRowMetadata();
      }
    },
    enabled: () => state.connected,
    interval: THREAD_LIST_POLL_MS,
    hiddenInterval: 8000,
  });
  const refreshThreadList = () => threadListPoller.run();
  const scheduleThreadListRefresh = (delay) => threadListPoller.schedule(delay);
  const scheduleActiveThreadSync = (delay) => activeThreadPoller.schedule(delay);
  const syncActiveThread = () => activeThreadPoller.run();
  function threadSummarySignature(threads) {
    return JSON.stringify(
      threads.map((thread) => [
        thread.id,
        thread.name,
        thread.preview,
        thread.cwd,
        thread.projectless,
        thread.updatedAt,
        thread.recencyAt,
        thread.status,
        thread.error,
        thread.failure,
        thread.lastError,
        thread.model,
        thread.modelProvider,
        thread.reasoningEffort,
      ]),
    );
  }
  function applyThreadSummaries(threads) {
    threadListHasFreshData = true;
    threads = statusPort.rememberSummaryErrors(threads);
    repositoriesPort.sidebarCache.saveThreads(threads, state.config.home);
    for (const thread of threads) modelsPort.applySessionSettings(thread.id, thread);
    void repositoriesPort.conversations.saveSummaries(threads);
    const nextSignature = threadSummarySignature(threads),
      changed = nextSignature !== threadListSignature;
    threadListSignature = nextSignature;
    const previous = new Map(state.threads.map((thread) => [thread.id, thread]));
    sessions.replaceThreads(
      threads.map((thread) => ({
        ...thread,
        lastActivityAt: Math.max(threadLastActivityAt(thread), previous.get(thread.id)?.lastActivityAt || 0),
      })),
    );
    const summary = state.active && threads.find((thread) => thread.id === state.active?.id);
    if (summary && state.active) {
      const turns = state.active.turns;
      sessions.replaceActive({ ...state.active, ...summary, turns });
      if (summary.status?.type === "active") scheduleActiveThreadSync(0);
    }
    if (changed) viewUpdates.request("sidebar");
    else statusPort.refreshThreadRowMetadata();
    viewUpdates.request("goals");
    viewUpdates.request("status");
    statusPort.syncThreadErrorSurface();
    workspacePreparation.complete("sessions");
  }
  function refreshThreadsSoon() {
    scheduleThreadListRefresh(600);
  }
  function resetActiveThreadSync() {
    activeThreadPoller.reset();
    activeThreadSyncSignature = "";
  }
  let resumeSessionSyncLastAt = 0;
  function resumeSessionSync() {
    if (document.visibilityState === "hidden" || Date.now() - resumeSessionSyncLastAt < 1500) return;
    resumeSessionSyncLastAt = Date.now();
    queuePort.refreshMessageQueue();
    scheduleThreadListRefresh(0);
    viewUpdates.request("status");
    if (state.active && !activeThreadPoller.pending) {
      void syncActiveThread();
    } else scheduleActiveThreadSync(0);
  }
  async function latestThreadTurn(threadId) {
    try {
      const live = await transportPort.rpc("host/thread/live", { threadId });
      if (live?.active && live.turn) return live.turn;
    } catch (error) {
      reportDiagnostic("live-sessions", error);
    }
    const thread = await historyPort.readConversation(threadId, state.active);
    return thread?.turns?.at(-1) || null;
  }
  function syncTurnSnapshot(turn, threadId = state.active?.id) {
    if (!turn || !threadId || threadId !== state.active?.id) return false;
    const root = $("#conversation"),
      turns = [...(state.active.turns || [])],
      index = turns.findIndex((existing) => existing.id === turn.id);
    if (index < 0) turns.push(turn);
    else turns[index] = turn;
    sessions.setTurns(turns);
    timingPort.recordTurnTiming(turn.id, turn);
    findElements(".conversation-loading", root).forEach((node) => node.remove());
    timelinePort.renderTurn(turn, root);
    composerPort.syncTurnRuntime(turn);
    statusPort.updateThreadListActivity(threadId, {
      status: { type: turn.status === "inProgress" ? "active" : "idle" },
      turnId: turn.id,
      turnStatus: turn.status,
      completed: turn.status !== "inProgress",
      timestamp:
        typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt)
          ? turn.completedAt
          : typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt)
            ? turn.startedAt
            : undefined,
    });
    viewportPort.scrollBottom();
    return true;
  }
  async function syncActiveThreadRead(current) {
    const previous = state.active;
    if (!previous) return ACTIVE_THREAD_SYNC_IDLE_MS;
    const threadId = previous.id;
    let nextDelay = ACTIVE_THREAD_SYNC_IDLE_MS;
    try {
      if (previous.history) {
        const thread = await historyPort.readConversation(threadId, previous, {
          getCurrent: () => state.active,
        });
        if (!current() || threadId !== state.active?.id) return;
        sessions.replaceActive(thread);
        repositoriesPort.cacheConversation(thread);
        statusPort.syncThreadErrorsFromTurns(threadId, thread.turns || []);
        const latest = thread.turns.at(-1);
        if (latest) {
          nextDelay = latest.status === "inProgress" ? ACTIVE_THREAD_SYNC_ACTIVE_MS : ACTIVE_THREAD_SYNC_IDLE_MS;
          statusPort.syncThreadErrorSurface(threadId);
          composerPort.syncTurnRuntime(latest);
        } else viewUpdates.request("composerSubmit");
        if (thread.history?.reset || thread.history?.removedItems) {
          viewUpdates.request("conversation", { thread: thread, loadMore: 0 });
        } else if (!thread.history?.unchanged) {
          for (const turn of thread.turns) {
            const old = previous.turns.find((item) => item.id === turn.id);
            if (JSON.stringify(old) !== JSON.stringify(turn)) syncTurnSnapshot(turn, threadId);
          }
        }
        return nextDelay;
      }
      const turn = await latestThreadTurn(threadId);
      if (!current() || threadId !== state.active?.id) return;
      if (turn) {
        const signature = JSON.stringify(turn);
        nextDelay = turn.status === "inProgress" ? ACTIVE_THREAD_SYNC_ACTIVE_MS : ACTIVE_THREAD_SYNC_IDLE_MS;
        if (signature !== activeThreadSyncSignature) {
          activeThreadSyncSignature = signature;
          syncTurnSnapshot(turn, threadId);
        }
      }
    } catch {
      if (current()) void historyPort.resyncActiveConversation();
    } finally {
      if (current() && threadId === state.active?.id) historyPort.syncConversationLoadingSurface(false);
    }
    return nextDelay;
  }
  return {
    stopSynchronization() {
      threadListPoller.reset();
      resetActiveThreadSync();
    },
    resetActiveThreadSync,
    scheduleActiveThreadSync,
    get threadListHasFreshData() {
      return threadListHasFreshData;
    },
    ACTIVE_THREAD_SYNC_IDLE_MS,
    applyThreadSummaries,
    scheduleThreadListRefresh,
    refreshThreadList,
    refreshThreadsSoon,
    resumeSessionSync,

    syncTurnSnapshot,
  };
}
