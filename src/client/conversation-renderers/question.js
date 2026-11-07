import { closeAsyncQuestionCard, createAsyncQuestionCard, readAsyncQuestions } from "../async-questions.js";
import { closestElement, findElement, requireElement } from "../dom.js";

// Owns this element type; identity, transactions and lifecycle belong to the caller.
/** @param {Pick<import("./types.js").ConversationRendererServices, "state" | "mutations" | "turnFramesPort" | "activityPort" | "submissionPort" | "timingPort" | "viewUpdates" | "t">} services */
export function createQuestionRenderer({
  state,
  mutations,
  turnFramesPort,
  activityPort,
  submissionPort,
  timingPort,
  viewUpdates,
  t,
}) {
  return {
    id: "question",
    types: ["agentMessage", "mcpToolCall", "dynamicToolCall"],
    matches: (item) => Boolean(readAsyncQuestions(item)),
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root, element }) {
      let el = element;
      const questions = readAsyncQuestions(item);
      if (!questions) return null;

      // Structured questions may arrive after the initial text-only item.
      if (el && !el.matches("[data-async-question-card]")) {
        el.remove();
        mutations.collection("items").delete(item.id);
        el = null;
      }
      if (!el) {
        // Arguments can arrive after the generic tool row; replace that row once.
        const oldRow = findElement(
          `[data-item-id="${CSS.escape(activityPort.activityItemId(item))}"].activity-item`,
          root,
        );
        if (oldRow) {
          const group = closestElement("[data-agent-activity-group]", oldRow);
          oldRow.nextElementSibling?.remove();
          oldRow.remove();
          mutations.edit("activityItems", (draft) => draft.get(turnId)?.delete(activityPort.activityItemId(item)));
          if (findElement(".activity-item", group)) activityPort.updateActivitySummary(group);
          else group?.remove();
        }
        const questionThreadId = state.active?.id;
        el = createAsyncQuestionCard(item, questions, {
          t,
          onChange: () => viewUpdates.request("sessionWorkspace"),
          sendAnswer: (answer) =>
            submissionPort.submitPrompt({ preventDefault() {} }, { text: answer, threadId: questionThreadId || "" }),
        });
      }
      el.dataset.itemId = String(item.id);
      if (!root.contains(el))
        requireElement(".turn-event-stream", turnFramesPort.ensureTurnTimeline(turnId, root)).append(el);
      mutations.collection("items").set(item.id, el);
      if (item.questionState === "earlier") closeAsyncQuestionCard(el, t);
      timingPort.syncWorkedForDivider(turnId);
      viewUpdates.request("sessionWorkspace");

      return el;
    },
  };
}
