import { messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";

import { DEFAULT_TURN_PAGE_SIZE, createTurnWindow } from "../ui-core.js";
import { pandaInterfaceMark } from "../panda-brand.js";

// Owns timeline frames, render batches and pagination controls; item presentation is delegated.
export function assembleTimeline({
  renderBatch,
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
      if (!card.isConnected || !card.closest("#approvalInboxDialog")) mutations.collection("requestCards").delete(id);
    viewUpdates.request("sideTasks");
  }
  function renderThread(thread, loadMore = 0) {
    const root = $("#conversation"),
      turns = thread.turns || [];
    statusPort.syncThreadErrorsFromTurns(thread.id, turns);
    mutations.set(
      "turnWindow",
      createTurnWindow(
        turns,
        DEFAULT_TURN_PAGE_SIZE,
        state.turnWindow?.threadId === thread.id ? state.turnWindow.start : undefined,
        loadMore,
      ),
    );
    mutations.edit("turnWindow", (record) => (record.threadId = thread.id));
    clearConversationRuntime();
    setMessageHtml(root, "");
    statusPort.syncThreadErrorSurface(thread.id);
    if (state.turnWindow.hiddenCount || thread.history?.nextCursor) {
      const more = document.createElement("button");
      more.className = "load-older";
      setOpaqueText(
        more,
        state.turnWindow.hiddenCount
          ? `Load earlier messages (${state.turnWindow.hiddenCount})`
          : t("sessions.loadEarlierMessages"),
      );
      more.onclick = async () => {
        const current = state.active?.id === thread.id ? state.active : thread;
        if (state.turnWindow.hiddenCount) {
          renderThread(current, DEFAULT_TURN_PAGE_SIZE);
          return;
        }
        if (historyPort.conversationItemCount(current) > historyPort.conversationItemCount(thread)) {
          const height = root.scrollHeight,
            top = root.scrollTop;
          mutations.set("turnWindow", null);
          renderThread(current, current.turns.length);
          root.scrollTop = top + root.scrollHeight - height;
          return;
        }
        more.disabled = true;
        try {
          await historyPort.loadEarlierConversation(current);
        } catch (error) {
          if (await historyPort.resyncActiveConversation()) return;
          noticesPort.addPersistentError(error.message);
          more.disabled = false;
        }
      };
      root.append(more);
    }
    for (const turn of state.turnWindow.visible) renderTurn(turn, root);
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
      for (const item of turn.items || []) {
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
