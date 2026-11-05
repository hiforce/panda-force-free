import { localizeAttribute, setMessageHtml } from "../i18n.js";

import { codexIcon } from "../codex-icons.js";
import { attachmentsFromInput, composerTextFromInput } from "../composer-attachments.js";

// Owns drafts, IME input and submit-control projections; native delivery is delegated.
/** @param {import("./ports.js").FeatureOptions<"drafts" | "mutations" | "state" | "$" | "t" | "viewUpdates", "uploads" | "status" | "delivery" | "models", "composer">} options */
export function assembleComposer({
  drafts,
  mutations,
  state,
  $,
  t,
  uploadsPort,
  statusPort,
  deliveryPort,
  viewUpdates,
  modelsPort,
}) {
  const {
    composerHistory,
    loadComposerHistory,
    persistComposerDraft,
    clearComposerDraft,
    getComposerDraft,
    setComposerDraft,
  } = drafts;
  function saveComposerDraft() {
    persistComposerDraft();
  }
  function restoreComposerDraft() {
    composerHistory.setReplay(
      (state.active?.turns || []).flatMap((turn) =>
        (turn.items || [])
          .filter((item) => item.type === "userMessage")
          .map((item) => ({
            text: composerTextFromInput(item.content),
            attachments: attachmentsFromInput(item.content),
          })),
      ),
    );
    const draft = getComposerDraft();
    $("#prompt").value = draft?.text || "";
    mutations.set("composerMentions", draft?.mentions || []);
    mutations.set("composerAttachments", [...(draft?.attachments || [])]);
    uploadsPort.renderComposerAttachments();
    resizePrompt();
  }
  let promptComposing = false;

  function activeTurnId() {
    return statusPort.sessionRuntime.activeTurnId(state.active);
  }
  function syncQueueButton() {
    const queue = $("#queueButton");
    if (queue)
      queue.disabled =
        (!$("#prompt").value.trim() && !state.composerAttachments.length) ||
        !uploadsPort.composerAttachmentsReady() ||
        promptComposing ||
        deliveryPort.isSending(deliveryPort.pendingMessageOwner());
  }
  function syncComposerSubmitState() {
    syncQueueButton();
    const button = $("#sendButton");
    if (!button) return;
    button.dataset.turnId = activeTurnId();
    button.disabled = !uploadsPort.composerAttachmentsReady();
    const mode = activeTurnId()
        ? $("#prompt").value.trim() || state.composerAttachments.length
          ? "steer"
          : "stop"
        : "send",
      label = mode === "stop" ? "common.stop" : mode === "steer" ? "sessions.steer" : "common.sendMessage";
    // Preserve the pressed element when polling refreshes an unchanged control.
    if (button.dataset.submitMode !== mode || !button.firstElementChild)
      setMessageHtml(button, codexIcon(mode === "stop" ? "square" : "arrowUp"));
    button.dataset.submitMode = mode;
    button.classList.toggle("stop", mode === "stop");
    button.classList.toggle("steer", mode === "steer");
    localizeAttribute(button, "title", label, undefined, t);
    localizeAttribute(button, "aria-label", label, undefined, t);
  }
  function setActiveTurnId(turnId = "") {
    const threadId = state.active?.id,
      previous = statusPort.sessionRuntime.get(threadId)?.turn;
    if (!threadId) return;
    if (turnId)
      statusPort.updateThreadListActivity(threadId, { status: { type: "active" }, turnId, turnStatus: "inProgress" });
    else if (previous?.status === "inProgress")
      statusPort.updateThreadListActivity(threadId, {
        status: { type: "idle" },
        turnId: previous.id,
        turnStatus: "interrupted",
        completed: true,
      });
    syncComposerSubmitState();
  }
  function syncTurnRuntime(turn) {
    if (state.active) statusPort.sessionRuntime.observeTurn(state.active.id, turn, state.active.turns.at(-1)?.id);
    syncComposerSubmitState();
  }
  function resizePrompt() {
    const e = $("#prompt");
    e.style.height = "auto";
    e.style.height = Math.min(190, e.scrollHeight) + "px";
    syncComposerSubmitState();
  }
  function setComposing(value) {
    promptComposing = value;
  }

  function setPlanMode(active) {
    mutations.set("planMode", Boolean(active));
    viewUpdates.request("composerPlaceholder");
    modelsPort.syncPermissionControl();
  }
  return {
    setPlanMode,
    setComposing,
    syncQueueButton,
    saveComposerDraft,
    syncComposerSubmitState,
    persistComposerDraft,
    composerHistory,
    restoreComposerDraft,
    resizePrompt,
    syncTurnRuntime,
    get promptComposing() {
      return promptComposing;
    },
    activeTurnId,
    getComposerDraft,
    setComposerDraft,
    loadComposerHistory,
    setActiveTurnId,
    clearComposerDraft,
  };
}
