import { CONVERSATION_INTERACTION } from "./conversation-interactions.js";
import { findElement, findElements, requireElement } from "./dom.js";
import { localizeText } from "./i18n.js";
import { createUserInputCard } from "./user-input.js";

export { readAsyncQuestions } from "../shared/engine/async-questions.js";

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

export function createAsyncQuestionCard(item, questions, { t, sendAnswer, onChange = () => {} }) {
  const details = document.createElement("details");
  details.dataset.asyncQuestionCard = "";
  details.setAttribute(CONVERSATION_INTERACTION, "");
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
        onChange();
        try {
          const result = await sendAnswer(text);
          if (result?.deliveryUncertain) details.dataset.status = "unconfirmed";
        } catch (error) {
          details.dataset.status = "open";
          onChange();
          throw error;
        }
      },
      onResolved: () => {
        details.open = false;
        const uncertain = details.dataset.status === "unconfirmed";
        details.dataset.status = uncertain ? "unconfirmed" : "submitted";
        onChange();
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
