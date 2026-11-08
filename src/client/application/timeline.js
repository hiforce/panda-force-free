import { isRetainedConversationItem, retainInteractionFocus } from "../conversation-interactions.js";
import { retireAnsweredAsyncQuestions } from "../../shared/engine/async-questions.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { errorMessage } from "./../../shared/errors.js";
import { closestElement } from "./../dom.js";

import { pandaInterfaceMark } from "../panda-brand.js";
import { DEFAULT_TURN_PAGE_SIZE, createTurnWindow } from "../ui-core.js";

// Owns timeline frames, render batches and pagination controls; item presentation is delegated.
/** @param {import("./ports.js").FeatureOptions<"renderBatch" | "selection" | "viewUpdates" | "mutations" | "state" | "$" | "t" | "escapeHtml", "status" | "viewport" | "history" | "notices" | "queue" | "timing" | "messages", "timeline">} options */
export function assembleTimeline({
  renderBatch,
  selection,
  viewUpdates,
  mutations,
  state,
  $,
  t,
  escapeHtml,
  statusPort,
  viewportPort,
  historyPort,
  noticesPort,
  queuePort,
  timingPort,
  messagesPort,
}) {
  const earlierLoads = new Set();
  let requestedHistoryWindow = 0;
  /** @param {HTMLButtonElement} button @param {boolean} loading */
  function syncEarlierButton(button, loading) {
    button.disabled = loading;
    button.setAttribute("aria-busy", String(loading));
    const spinner = button.firstElementChild;
    if (spinner instanceof HTMLElement) spinner.hidden = !loading;
    const count = Number(button.dataset.earlierCount) || 0;
    if (loading) localizeText(button.lastElementChild, "sessions.loadingEarlierMessages", undefined, t);
    else if (count) localizeText(button.lastElementChild, "sessions.loadEarlierMessagesCount", { count }, t);
    else localizeText(button.lastElementChild, "sessions.loadEarlierMessages", undefined, t);
  }
  function clearConversationRuntime({ retainItems = false } = {}) {
    if (!retainItems) requestedHistoryWindow = 0;
    viewUpdates.request("approvalMenu");
    // Preserve loaded media and interactive controls during same-session projections.
    // Navigation calls the default path and drops all cards from the prior session.
    for (const [id, node] of state.items)
      if (!retainItems || !isRetainedConversationItem(node)) {
        messagesPort.releaseItem(node);
        mutations.collection("items").delete(id);
      }
    mutations.collection("turns").clear();
    mutations.collection("turnTimings").clear();
    mutations.collection("activities").clear();
    mutations.collection("activityItems").clear();
    mutations.collection("sideTasks").clear();
    mutations.collection("dividers").clear();
    // The request inbox is independent of the conversation. Keep its live
    // cards registered when history or transport recovery rebuilds the timeline.
    for (const [id, card] of state.requestCards)
      if (!card.isConnected || !closestElement("#approvalInboxDialog", card))
        mutations.collection("requestCards").delete(id);
    viewUpdates.request("sideTasks");
  }
  function renderThread(thread, loadMore = 0) {
    if (!thread) return Promise.resolve();
    requestedHistoryWindow = Math.max(requestedHistoryWindow, loadMore);
    return viewportPort.renderHistoryWhenIdle(() => {
      if (state.active?.id !== thread.id) return;
      // Coalescing snapshots must not discard an explicit load-older request.
      const requested = requestedHistoryWindow;
      requestedHistoryWindow = 0;
      // Native events may have arrived while the user was touching the history.
      viewportPort.preserveReadingPosition(() => renderThreadContent(state.active, requested));
    });
  }
  function renderThreadContent(thread, loadMore) {
    const root = $("#conversation"),
      turns = thread.turns || [];
    statusPort.syncThreadErrorsFromTurns(thread.id, turns);
    const window = createTurnWindow(
      turns,
      DEFAULT_TURN_PAGE_SIZE,
      state.turnWindow?.threadId === thread.id ? state.turnWindow?.start : undefined,
      loadMore,
    );
    window.threadId = thread.id;
    mutations.set("turnWindow", window);
    const restoreFocus = retainInteractionFocus(root);
    clearConversationRuntime({ retainItems: true });
    setMessageHtml(root, "");
    statusPort.syncThreadErrorSurface(thread.id);
    if (window.hiddenCount || thread.history?.nextCursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "load-older";
      more.dataset.earlierCount = String(window.hiddenCount);
      setMessageHtml(
        more,
        '<span class="conversation-loading-spinner" aria-hidden="true" hidden></span><span aria-live="polite"></span>',
      );
      syncEarlierButton(more, earlierLoads.has(thread.id));
      more.onclick = async () => {
        if (earlierLoads.has(thread.id) || state.active?.id !== thread.id) return;
        const generation = selection.current;
        earlierLoads.add(thread.id);
        syncEarlierButton(more, true);
        try {
          let current = state.active;
          if (!current) return;
          if (
            window.hiddenCount ||
            historyPort.conversationItemCount(current) > historyPort.conversationItemCount(thread)
          ) {
            // Paint feedback before a potentially expensive cached-history render.
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const active = state.active;
            if (!selection.isCurrent(generation) || !active || active.id !== thread.id) return;
            current = active;
          }
          if (window.hiddenCount) {
            await renderThread(current, DEFAULT_TURN_PAGE_SIZE);
            return;
          }
          if (historyPort.conversationItemCount(current) > historyPort.conversationItemCount(thread)) {
            mutations.set("turnWindow", null);
            await renderThread(current, current.turns.length);
            return;
          }
          const earlier = await historyPort.loadEarlierConversation(current);
          if (earlier && selection.isCurrent(generation) && state.active?.id === thread.id)
            await renderThread(earlier, earlier.turns?.length || 0);
        } catch (error) {
          if (!selection.isCurrent(generation) || state.active?.id !== thread.id) return;
          if (await historyPort.resyncActiveConversation()) return;
          if (selection.isCurrent(generation) && state.active?.id === thread.id)
            noticesPort.addPersistentError(errorMessage(error));
        } finally {
          earlierLoads.delete(thread.id);
          const button = root.querySelector(".load-older");
          if (state.active?.id === thread.id && button instanceof HTMLButtonElement) syncEarlierButton(button, false);
        }
      };
      root.append(more);
    }
    for (const turn of window.visible) renderTurn(turn, root);
    for (const [id, node] of state.items)
      if (!root.contains(node)) {
        messagesPort.releaseItem(node);
        mutations.collection("items").delete(id);
      }
    restoreFocus();
    viewUpdates.request("approvals");
    viewUpdates.request("pendingMessages");
    if (!root.children.length) showEmpty();
    else if (!loadMore) viewportPort.scrollBottom();
  }
  function showEmpty() {
    queuePort.renderMessageQueue();
    const root = $("#conversation");
    setMessageHtml(
      root,
      `<div class="empty-state" id="emptyState">${pandaInterfaceMark("empty-panda-mark")}<h1>${messageHtml("common.whatCanIHelp", undefined, t)}</h1></div>`,
    );
    viewUpdates.request("pendingMessages");
    viewUpdates.request("approvals");
  }

  function renderTurn(turn, root = $("#conversation")) {
    viewportPort.preserveReadingPosition(() => renderTurnContent(turn, root));
  }
  function renderTurnContent(turn, root) {
    timingPort.recordTurnTiming(turn.id, turn);
    let userSeen = false;
    renderBatch.begin();
    try {
      for (const item of retireAnsweredAsyncQuestions([turn])[0].items) {
        messagesPort.upsertItem(
          item.type === "userMessage" ? { ...item, steer: item.steer || userSeen } : item,
          turn.id,
          root,
          false,
        );
        if (item.type === "userMessage") userSeen = true;
      }
    } finally {
      renderBatch.end(turn.id);
      timingPort.syncWorkedForDivider(turn.id, timingPort.turnDurationMs(turn));
    }
  }
  return {
    showEmpty,
    clearConversationRuntime,
    renderThread,
    renderTurn,
  };
}
