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

export function closeEarlierAsyncQuestions(root, t) {
  for (const card of root.querySelectorAll("[data-async-question-card]")) {
    card.open = false;
    card.dataset.status = "earlier";
    card.querySelector("summary").textContent = t("Earlier question");
    for (const fieldset of card.querySelectorAll("fieldset")) fieldset.disabled = true;
    card.querySelector("[type=submit]").hidden = true;
    card.querySelector(".async-question-hint").textContent = t(
      "You continued the conversation. This question is kept as history.",
    );
  }
}

export function createAsyncQuestionCard(item, questions, { t, prepareAnswer }) {
  const details = document.createElement("details");
  details.dataset.asyncQuestionCard = "";
  details.dataset.itemId = String(item.id);
  details.dataset.status = "open";
  details.className = "async-question-card";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = t("Question for you");
  const hint = document.createElement("p");
  hint.className = "async-question-hint";
  hint.textContent = t("Choose or write an answer, add it to your message, then send it in the conversation.");
  const form = createUserInputCard(
    { id: item.id, params: { questions } },
    {
      t,
      submitLabel: "Add answer to message",
      headingLabel: "Choose an answer",
      respond: async (_id, result) => {
        const text = questions
          .map((question) => question.question + "\n" + result.answers[question.id].answers.join("\n"))
          .join("\n\n");
        await prepareAnswer(text);
      },
      onResolved: () => {
        details.open = false;
        details.dataset.status = "prepared";
        summary.textContent = t("Answer added to message");
        hint.textContent = t("Send the message to deliver your answer.");
      },
      onError: () => {},
    },
  );
  details.append(summary, hint, form);
  return details;
}
