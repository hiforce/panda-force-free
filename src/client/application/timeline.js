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
  function clearConversationRuntime() {
    viewUpdates.request("approvalMenu");
    mutations.collection("items").clear();
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
    viewportPort.preserveReadingPosition(() => renderThreadContent(thread, loadMore));
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
    clearConversationRuntime();
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
            renderThread(current, DEFAULT_TURN_PAGE_SIZE);
            return;
          }
          if (historyPort.conversationItemCount(current) > historyPort.conversationItemCount(thread)) {
            mutations.set("turnWindow", null);
            renderThread(current, current.turns.length);
            return;
          }
          await historyPort.loadEarlierConversation(current);
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
