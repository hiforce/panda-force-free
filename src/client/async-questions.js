import { findElement, findElements, requireElement } from "./dom.js";
import { localizeText } from "./i18n.js";
import { createUserInputCard } from "./user-input.js";

// These tools receive answers through later chat messages, not native approval RPCs.
export function readAsyncQuestions(item) {
  if (!["mcpToolCall", "dynamicToolCall"].includes(item?.type)) return null;
  const name = item.tool || item.name || item.function?.name || "";
  if (!/(?:^|[./_])request_user_input(?:_async)?$/.test(name)) return null;
  let input = item.arguments ?? item.input ?? item.function?.arguments;
  if (typeof input === "string") {
    if (input.length > 1024 * 1024) return null;
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 30) return null;
  if (
    input.questions.some(
      (question) =>
        !question ||
        typeof question !== "object" ||
        (question.options !== undefined && !Array.isArray(question.options)),
    )
  )
    return null;
  const questions = input.questions.map((question, index) => ({
    id: String(index),
    header: question.header || "",
    question: question.title || question.question || "",
    isOther: true,
    isSecret: question.isSecret === true,
    options: (question.options || []).map((option) => (typeof option === "string" ? { label: option } : option)),
  }));
  if (
    questions.some(
      (question) =>
        typeof question.question !== "string" ||
        !question.question ||
        question.options.some((option) => !option || typeof option.label !== "string"),
    )
  )
    return null;
  return questions;
}

export function closeAsyncQuestionCard(card, t) {
  if (["submitting", "unconfirmed", "submitted", "earlier"].includes(card.dataset.status)) return;
  card.open = false;
  card.dataset.status = "earlier";
  localizeText(findElement("summary", card), "approvals.earlierQuestion", undefined, t);
  for (const fieldset of findElements("fieldset", card)) fieldset.disabled = true;
  requireElement("[type=submit]", card).hidden = true;
  localizeText(
    findElement(".async-question-hint", card),
    "approvals.youContinuedTheConversationThisQuestionIsKeptAsHistory",
    undefined,
    t,
  );
}

export function closeEarlierAsyncQuestions(root, t) {
  for (const card of findElements("[data-async-question-card]", root)) closeAsyncQuestionCard(card, t);
}

export function createAsyncQuestionCard(item, questions, { t, sendAnswer }) {
  const details = document.createElement("details");
  details.dataset.asyncQuestionCard = "";
  details.dataset.itemId = String(item.id);
  details.dataset.status = "open";
  details.className = "async-question-card";
  details.open = true;
  const summary = document.createElement("summary");
  localizeText(summary, "approvals.questionForYou", undefined, t);
  const hint = document.createElement("p");
  hint.className = "async-question-hint";
  localizeText(hint, "approvals.chooseOrWriteYourAnswersThenSubmitThemDirectlyTo", undefined, t);
  const form = createUserInputCard(
    { id: item.id, params: { questions } },
    {
      t,
      submitLabel: "common.submitAnswer",
      headingLabel: "common.chooseAnAnswer",
      respond: async (_id, result) => {
        const text = questions
          .map((question) => question.question + "\n" + result.answers[question.id].answers.join("\n"))
          .join("\n\n");
        details.dataset.status = "submitting";
        try {
          const result = await sendAnswer(text);
          if (result?.deliveryUncertain) details.dataset.status = "unconfirmed";
        } catch (error) {
          details.dataset.status = "open";
          throw error;
        }
      },
      onResolved: () => {
        details.open = false;
        const uncertain = details.dataset.status === "unconfirmed";
        details.dataset.status = uncertain ? "unconfirmed" : "submitted";
        localizeText(summary, uncertain ? "workbench.deliveryUnconfirmed" : "common.answerSubmitted", undefined, t);
        localizeText(
          hint,
          uncertain
            ? "common.checkTheMessageDeliveryStatusBeforeSendingAgain"
            : "common.yourAnswerHasBeenSentToTheConversation",
          undefined,
          t,
        );
        requireElement("[type=submit]", form).hidden = true;
      },
      onError: () => {},
    },
  );
  details.append(summary, hint, form);
  if (item.questionState === "earlier") closeAsyncQuestionCard(details, t);
  return details;
}
