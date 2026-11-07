import { findElement } from "../dom.js";
import { isConversationInteraction } from "../conversation-interactions.js";
import { closeEarlierAsyncQuestions, readAsyncQuestions } from "../async-questions.js";
import { isAsyncQuestionReply } from "../../shared/engine/async-questions.js";
import { createBuiltinConversationRenderers } from "../conversation-renderers/index.js";
// Reconciles identity and dispatches through the session-local renderer registry.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "$" | "state" | "t" | "escapeHtml", "turnFrames" | "identity" | "sideTasks" | "viewport" | "activity" | "submission" | "queue" | "timing" | "clipboard" | "review", "messages">} options */
export function assembleMessages({
  turnFramesPort,
  viewUpdates,
  mutations,
  $,
  state,
  t,
  identityPort,
  sideTasksPort,
  viewportPort,
  activityPort,
  submissionPort,
  queuePort,
  timingPort,
  clipboardPort,
  reviewPort,
}) {
  const renderers = createBuiltinConversationRenderers({
    state,
    mutations,
    turnFramesPort,
    activityPort,
    submissionPort,
    timingPort,
    viewUpdates,
    t,
    queuePort,
    identityPort,
    clipboardPort,
    reviewPort,
    sideTasksPort,
  });
  function upsertItem(item, turnId, root = $("#conversation"), live = true) {
    if (!live) return renderItem(item, turnId, root, live);
    viewportPort.preserveReadingPosition(() => renderItem(item, turnId, root, live));
  }
  function renderItem(item, turnId, root, live) {
    findElement("#emptyState", root)?.remove();
    let el = state.items.get(item.id) || null;
    const questions = readAsyncQuestions(item);
    if (el && !root.contains(el) && !isConversationInteraction(el)) {
      renderers.release(el);
      mutations.collection("items").delete(item.id);
      el = null;
    }
    const followSubmission = live && !el && item.type === "userMessage" && String(item.id).startsWith("local-");
    if (!el && item.type === "userMessage")
      el =
        identityPort.claimOptimisticUser(item, root, turnId) ||
        identityPort.claimEquivalentUserMessage(item, root, turnId);
    // History hydration and aliases of an existing prompt are not new answers.
    if (!el && live && isAsyncQuestionReply(item)) {
      closeEarlierAsyncQuestions(root, t);
      viewUpdates.request("sessionWorkspace");
    }
    if (!el && questions && item.questionSourceId) {
      const alias = state.items.get(item.questionSourceId);
      if (alias?.matches("[data-async-question-card]")) {
        el = alias;
        el.dataset.itemId = String(item.id);
        mutations.collection("items").set(item.id, el);
      }
    }
    if (!el && item.type === "agentMessage" && !questions) el = identityPort.claimEquivalentAgentMessage(item, turnId);
    const renderer = renderers.resolve(item);
    if (!renderer) return;
    el = renderers.render(renderer, { item, turnId, root, element: el });
    if (!el) return;
    if (renderer.itemRoot !== false) {
      el.dataset.itemId = String(item.id);
      mutations.collection("items").set(item.id, el);
    }
    if (live) viewportPort.scrollBottom({ force: followSubmission });
  }
  function appendAssistantDelta(params) {
    const existing = state.items.get(params.itemId);
    // Structured controls own their payload; a late text delta cannot replace them.
    if (existing && isConversationInteraction(existing)) return;
    const body = existing && findElement(".message-text", existing);
    upsertItem(
      {
        id: params.itemId,
        type: "agentMessage",
        status: "inProgress",
        text: (body?.dataset.raw || "") + (params.delta || ""),
        receivedAt: existing?.dataset.messageTimestamp || params.pandaReceivedAt,
      },
      params.turnId,
    );
  }
  return { upsertItem, appendAssistantDelta, releaseItem: (node) => renderers.release(node) };
}
