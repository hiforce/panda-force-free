import { storage, STORAGE_KEYS } from "../storage.js";
import { parseWorkbenchRoute } from "../workbench-route.js";

// Coordinates session selection, cache restoration and view transitions using one navigation generation.
export function assembleNavigation({
  selection,
  viewUpdates,
  mutations,
  sessions,
  state,
  $,
  t,
  projectsPort,
  composerPort,
  goalsPort,
  synchronizationPort,
  timelinePort,
  reviewPort,
  suggestionsPort,
  modelsPort,
  statusPort,
  viewportPort,
  historyPort,
  repositoriesPort,
  queuePort,
  noticesPort,
  configurationReadiness,
}) {
  function invalidateNavigation() {
    return selection.next();
  }
  function rememberActiveThread(id) {
    if (id) storage.set(STORAGE_KEYS.activeThread, String(id));
    else storage.remove(STORAGE_KEYS.activeThread);
  }
  function startNewTask({
    saveCurrentDraft = true,
    projectId = state.active
      ? projectsPort.businessProjects.projectForSession(state.active.id)?.id || null
      : state.newSessionProjectId || null,
  } = {}) {
    if (saveCurrentDraft) composerPort.saveComposerDraft();
    mutations.set("newSessionProjectId", projectId);
    viewUpdates.request("newTask");
    goalsPort.closeGoalDialog();
    composerPort.composerHistory.setReplay([]);
    invalidateNavigation();
    synchronizationPort.resetActiveThreadSync();
    rememberActiveThread(null);
    sessions.replaceActive(null);
    mutations.set("composerMentions", []);
    mutations.set("composerAttachments", []);
    mutations.set("turnWindow", null);
    timelinePort.clearConversationRuntime();
    mutations.collection("changes").clear();
    reviewPort.resetReviewState();
    suggestionsPort.closeComposerAutocomplete();
    $("#threadTitle").textContent = t("New session");
    $("#threadPath").textContent = state.projectless ? "" : $("#projectPath").textContent;
    composerPort.restoreComposerDraft();
    composerPort.setPlanMode(false);
    viewUpdates.request("workspaceContext");
    suggestionsPort.renderContextTray();
    viewUpdates.request("contextUsage");
    viewUpdates.request("composerLayout");
    if (!$("#summaryPanel").hidden) viewUpdates.request("details");
    timelinePort.showEmpty();
    viewUpdates.request("sidebar");
    viewUpdates.request("goals");
    viewUpdates.request("status");
    $("#prompt").focus();
  }
  function showOpenedConversation(thread, fromCache = false) {
    viewportPort.resetAutoScroll();
    viewportPort.syncConversationScrollSurface();
    synchronizationPort.resetActiveThreadSync();
    sessions.replaceActive(thread);
    rememberActiveThread(thread.id);
    if (state.sessionSettings.has(thread.id))
      modelsPort.applySessionSettings(thread.id, state.sessionSettings.get(thread.id));
    composerPort.restoreComposerDraft();
    mutations.set("turnWindow", null);
    timelinePort.clearConversationRuntime();
    mutations.collection("changes").clear();
    reviewPort.resetReviewState();
    suggestionsPort.closeComposerAutocomplete();
    suggestionsPort.renderContextTray();
    viewUpdates.request("contextUsage");
    viewUpdates.request("header");
    viewUpdates.request("sidebar");
    viewUpdates.request("status");
    if (thread.turns?.length) {
      viewUpdates.request("conversation", { thread: thread, loadMore: 0 });
      composerPort.syncTurnRuntime(thread.turns.at(-1));
      viewportPort.scrollOpenedThreadToBottom();
    } else {
      $("#conversation").innerHTML =
        `<div class="list-state conversation-loading">${fromCache ? "No conversation history loaded. Send a message to continue." : "Loading conversation…"}</div>`;
      statusPort.syncThreadErrorSurface(thread.id);
      viewUpdates.request("pendingMessages");
    }
    historyPort.syncConversationLoadingSurface(fromCache);
  }
  function startupThreadAllowed(id) {
    return (
      Boolean(id) &&
      (location.pathname === "/" || (parseWorkbenchRoute().page === "task" && parseWorkbenchRoute().id === id))
    );
  }
  async function restoreCachedStartup(id, current) {
    const generation = selection.current;
    // Restore the small sidebar before reading/deserializing a conversation.
    void repositoriesPort.conversations.summaries().then((summaries) => {
      if (
        current() &&
        generation === selection.current &&
        !repositoriesPort.cachedSidebar &&
        !synchronizationPort.threadListHasFreshData &&
        !state.threads.length &&
        summaries?.length
      ) {
        sessions.replaceThreads(summaries);
        viewUpdates.request("sidebar");
      }
    });
    const thread = startupThreadAllowed(id) ? await repositoriesPort.conversations.load(id) : null;
    if (!current() || generation !== selection.current || state.active) return;
    if (!thread) return;
    await configurationReadiness.ready;
    if (!current() || generation !== selection.current || state.active || id !== storage.get(STORAGE_KEYS.activeThread))
      return;
    repositoriesPort.conversations.remember(thread, { persisted: true });
    showOpenedConversation(thread, true);
    if (state.connected) synchronizationPort.scheduleActiveThreadSync(0);
  }
  async function openThread(id, fallbackSummary = null) {
    viewUpdates.request("sessionOpened", id);
    composerPort.saveComposerDraft();
    repositoriesPort.pruneConversationCaches();
    if (state.active?.turns?.length || repositoriesPort.conversations.has(state.active?.id))
      repositoriesPort.cacheConversation(state.active);
    const navigationId = invalidateNavigation();
    if (!repositoriesPort.conversations.has(id)) await repositoriesPort.conversations.load(id);
    if (!selection.isCurrent(navigationId)) return false;
    const listedSummary = state.threads.find((x) => x.id === id),
      cached = repositoriesPort.conversations.get(id),
      summary = listedSummary || fallbackSummary || cached,
      deferTransition = Boolean(fallbackSummary && !listedSummary && !cached);
    const showThread = (thread) => showOpenedConversation(thread, Boolean(cached));
    if (!deferTransition) {
      synchronizationPort.resetActiveThreadSync();
      rememberActiveThread(id);
      if (summary) showThread(cached ? { ...summary, ...cached } : summary);
    }
    try {
      const thread = await historyPort.readConversation(id, cached || summary, {
        limit: cached
          ? historyPort.BACKGROUND_CONVERSATION_HISTORY_LIMIT
          : historyPort.INITIAL_CONVERSATION_HISTORY_LIMIT,
      });
      if (!selection.isCurrent(navigationId)) return false;
      if (state.active?.id === id) composerPort.saveComposerDraft();
      repositoriesPort.cacheConversation(thread);
      if (cached && state.active?.id === id && thread.history?.unchanged) {
        sessions.replaceActive(thread);
        viewUpdates.request("header");
        composerPort.syncTurnRuntime(thread.turns.at(-1));
      } else showThread(thread);
      historyPort.syncConversationLoadingSurface(false);
      if (!thread.turns?.length) {
        $("#conversation").innerHTML =
          '<div class="list-state conversation-loading">No conversation history loaded. Send a message to continue.</div>';
        statusPort.syncThreadErrorSurface(thread.id);
        viewUpdates.request("pendingMessages");
      }
      queuePort.refreshMessageQueue(id);
      viewUpdates.request("approvals");
      // Let the latest messages paint before requesting a larger older page.
      const shouldPrefetch =
        thread.history?.nextCursor &&
        historyPort.conversationItemCount(thread) < historyPort.BACKGROUND_CONVERSATION_HISTORY_LIMIT;
      if (shouldPrefetch)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => void historyPort.prefetchEarlierConversation(thread, navigationId)),
        );
      synchronizationPort.scheduleActiveThreadSync(shouldPrefetch ? synchronizationPort.ACTIVE_THREAD_SYNC_IDLE_MS : 0);
      return true;
    } catch (error) {
      if (!selection.isCurrent(navigationId)) return false;
      if (cached) {
        historyPort.syncConversationLoadingSurface(false);
        viewUpdates.request("approvals");
        synchronizationPort.scheduleActiveThreadSync(0);
        return false;
      }
      if (deferTransition) {
        noticesPort.addPersistentError(error?.message || "Could not load side task");
        return false;
      }
      if (!summary || state.active?.id !== id) return false;
      $("#conversation").innerHTML =
        '<div class="list-state conversation-loading">Could not load history. Send a message to start fresh.</div>';
      statusPort.syncThreadErrorSurface(id);
      historyPort.syncConversationLoadingSurface(false);
      viewUpdates.request("pendingMessages");
      return false;
    }
  }
  function bind() {
    $("#newTask").onclick = (...args) => startNewTask(...args);
  }
  return {
    bind,
    openThread,
    startNewTask,
    get threadNavigationGeneration() {
      return selection.current;
    },
    invalidateNavigation,
    rememberActiveThread,
    startupThreadAllowed,
    restoreCachedStartup,
  };
}
