import { localizeText, setMessageHtml } from "../i18n.js";
import { errorMessage } from "./../../shared/errors.js";
import { findElement } from "./../dom.js";

import { mergeConversationHistory } from "../ui-core.js";

// Reads and merges paged history with navigation guards and explicit recovery.
/** @param {import("./ports.js").FeatureOptions<"selection" | "viewUpdates" | "mutations" | "sessions" | "$" | "t" | "state", "transport" | "repositories" | "notices", "history">} options */
export function assembleHistory({
  transportPort,
  selection,
  viewUpdates,
  mutations,
  sessions,
  $,
  t,
  state,
  repositoriesPort,
  noticesPort,
}) {
  const INITIAL_CONVERSATION_HISTORY_LIMIT = 20;
  const BACKGROUND_CONVERSATION_HISTORY_LIMIT = 100;
  function syncConversationLoadingSurface(loading) {
    const root = $("#conversation");
    if (!root) return;
    const existing = findElement("[data-conversation-loading]", root);
    if (!loading) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const notice = document.createElement("div");
    notice.className = "conversation-loading-notice";
    notice.dataset.conversationLoading = "true";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    setMessageHtml(notice, '<span class="conversation-loading-spinner" aria-hidden="true"></span><span></span>');
    localizeText(notice.lastElementChild, "workbench.loadingConversation", undefined, t);
    root.prepend(notice);
  }
  let conversationResyncInFlight = false,
    conversationResyncLastAt = 0;
  async function resyncActiveConversation() {
    const threadId = state.active?.id;
    if (!threadId || conversationResyncInFlight || Date.now() - conversationResyncLastAt < 10000) return false;
    conversationResyncInFlight = true;
    conversationResyncLastAt = Date.now();
    const generation = selection.current;
    syncConversationLoadingSurface(true);
    const notice = findElement("[data-conversation-loading]", $("#conversation"));
    if (notice?.lastElementChild)
      localizeText(notice.lastElementChild, "workbench.refreshingConversation", undefined, t);
    try {
      const thread = await readConversation(threadId, state.active, {
        getCurrent: () => state.active,
      });
      if (generation !== selection.current || state.active?.id !== threadId) return false;
      if (!thread) throw new Error(t("errors.couldNotRefreshConversation"));
      sessions.replaceActive(thread);
      repositoriesPort.cacheConversation(thread);
      viewUpdates.request("header");
      viewUpdates.request("conversation", { thread: thread, loadMore: 0 });
      viewUpdates.request("sidebar");
      noticesPort.toast(t("workbench.conversationResynchronized"));
      return true;
    } catch (error) {
      console.warn("[panda-force] conversation resync failed:", error);
      noticesPort.addPersistentError(errorMessage(error) || t("errors.couldNotRefreshConversation"));
      return false;
    } finally {
      conversationResyncInFlight = false;
      if (state.active?.id === threadId) syncConversationLoadingSurface(false);
    }
  }
  /** @param {string} id @param {import("../../shared/data-view.js").DataView<import("../../shared/engine/types.js").SessionSummary> | null} previous @param {{limit?: number; getCurrent?: () => import("../../shared/data-view.js").DataView<import("../../shared/engine/types.js").SessionSummary> | null}} options */
  async function readConversation(id, previous, { limit = BACKGROUND_CONVERSATION_HISTORY_LIMIT, getCurrent } = {}) {
    try {
      const response = await transportPort.rpc("host/thread/history", {
        threadId: id,
        revision: previous?.history?.revision,
        oldestItemId: previous?.history?.oldestItemId,
        limit,
      });
      if (response.history) {
        // A load-older request may finish while this refresh is in flight. Merge
        // against the current view so the older page is not overwritten.
        const current = getCurrent?.();
        const thread = mergeConversationHistory(current?.id === id ? current : previous, response);
        thread.history.reset = response.history.mode === "snapshot";
        thread.history.removedItems = Boolean(response.history.removedItemIds?.length);
        thread.history.unchanged =
          response.history.mode === "delta" &&
          !response.history.removedItemIds?.length &&
          !response.history.questionTurns?.some((turn) => turn.items?.length) &&
          !response.history.turns.length;
        return thread;
      }
    } catch (error) {
      if (!/not available|unknown|unsupported|method not found/i.test(errorMessage(error) || "")) throw error;
    }
    const result = await transportPort.rpc("thread/read", { threadId: id, includeTurns: true });
    return { ...previous, ...result.thread };
  }
  function conversationItemCount(thread) {
    return (thread?.turns || []).reduce((count, turn) => count + (turn.items || []).length, 0);
  }
  async function prefetchEarlierConversation(thread, navigationId) {
    const id = thread?.id,
      cursor = thread?.history?.nextCursor;
    if (!id || !cursor || !selection.isCurrent(navigationId)) return;
    try {
      const result = await transportPort.rpc("host/thread/history", {
        threadId: id,
        cursor,
        limit: BACKGROUND_CONVERSATION_HISTORY_LIMIT,
      });
      if (!selection.isCurrent(navigationId) || state.active?.id !== id || state.active?.history?.nextCursor !== cursor)
        return;
      const merged = mergeConversationHistory(state.active, result, { page: true });
      sessions.replaceActive(merged);
      repositoriesPort.cacheConversation(merged);
    } catch (error) {
      // Background history is an enhancement. The latest page is already usable;
      // leave the existing load-older control to retry the request on demand.
      console.warn("[panda-force] background conversation history failed:", errorMessage(error) || error);
    }
  }
  async function loadEarlierConversation(thread) {
    const current = state.active?.id === thread.id ? state.active : thread;
    const id = current.id,
      generation = selection.current;
    const result = await transportPort.rpc("host/thread/history", {
      threadId: id,
      cursor: current.history.nextCursor,
      limit: BACKGROUND_CONVERSATION_HISTORY_LIMIT,
    });
    if (generation !== selection.current || state.active?.id !== id) return;
    const merged = mergeConversationHistory(state.active, result, { page: true });
    sessions.replaceActive(merged);
    repositoriesPort.cacheConversation(merged);
    mutations.set("turnWindow", null);
    // The timeline preserves the current reading anchor, including movement while this request was pending.
    viewUpdates.request("conversation", { thread: merged, loadMore: merged.turns.length });
  }
  return {
    syncConversationLoadingSurface,
    readConversation,
    BACKGROUND_CONVERSATION_HISTORY_LIMIT,
    INITIAL_CONVERSATION_HISTORY_LIMIT,
    conversationItemCount,
    prefetchEarlierConversation,
    loadEarlierConversation,
    resyncActiveConversation,
  };
}
