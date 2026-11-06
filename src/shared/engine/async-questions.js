// These tools receive answers through later chat messages, not native approval RPCs.
export function readAsyncQuestions(item) {
  const native = item?.type === "agentMessage" && item.delivery === "async" && Array.isArray(item.questions);
  if (!native && !["mcpToolCall", "dynamicToolCall"].includes(item?.type)) return null;
  const name = item.tool || item.name || item.function?.name || "";
  if (!native && !/(?:^|[./_])request_user_input(?:_async)?$/.test(name)) return null;
  let input = native ? { questions: item.questions } : (item.arguments ?? item.input ?? item.function?.arguments);
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

export function isAsyncQuestionReply(item) {
  return (
    item?.type === "userMessage" &&
    Array.isArray(item.content) &&
    item.content.some(
      (part) =>
        (typeof part?.text === "string" && part.text.trim()) ||
        (["image", "localImage", "inputImage", "input_image"].includes(part?.type) &&
          Boolean(part.url || part.path || part.image_url)),
    )
  );
}

/** A later real user message supersedes optional host questions, never engine approvals. */
export function retireAnsweredAsyncQuestions(turns) {
  const result = turns.map((turn) => ({ ...turn, items: [...(turn.items || [])] }));
  const pending = [];
  for (const turn of result) {
    for (let index = 0; index < turn.items.length; index++) {
      const item = turn.items[index];
      if (isAsyncQuestionReply(item)) {
        for (const question of pending) {
          const previous = question.turn.items[question.index];
          question.turn.items[question.index] = { ...previous, questionState: "earlier" };
        }
        pending.length = 0;
      } else if (item.questionState !== "earlier" && readAsyncQuestions(item)) pending.push({ turn, index });
    }
  }
  return result;
}
