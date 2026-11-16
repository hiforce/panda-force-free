import { BotError, botText, type BotAction, type BotReview, type BotReviewAnswer, type BotTask } from "./contracts.js";
import { isRecord } from "../records.js";

/** Only the task submitter grants callback authority. Model proposals contain references, never endpoints. */
export function botTaskActions(task: Pick<BotTask, "input">): BotAction[] {
  if (task.input.actions !== undefined) return task.input.actions;
  if (!task.input.callbacks) return [];
  return [
    { id: "keep", label: "Keep" },
    {
      id: "discard",
      label: "Discard",
      ...(task.input.callbacks?.discard ? { callback: task.input.callbacks.discard } : {}),
    },
  ];
}
export function botTaskAction(task: Pick<BotTask, "input">, id: string | null | undefined) {
  return (
    botTaskActions(task).find((action) => action.id === id) ??
    (task.input.actions === undefined && (id === "keep" || id === "discard") ? { id, label: id } : undefined)
  );
}
export function botHasCallbackDecision(task: Pick<BotTask, "input" | "decision">) {
  return (
    !!botTaskAction(task, task.decision)?.callback || (task.input.actions === undefined && task.decision === "discard")
  );
}
export function botTaskReview(task: Pick<BotTask, "id" | "updatedAt" | "reason" | "review">): BotReview {
  return task.review ?? { id: "legacy:" + task.id + ":" + task.updatedAt, question: task.reason ?? "", options: [] };
}
export function botReviewProposal(value: unknown, task: Pick<BotTask, "input">): Omit<BotReview, "id"> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => !["question", "options"].includes(k)) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 6
  )
    throw new BotError("invalidReview");
  const ids = new Set<string>();
  return {
    question: botText(value.question, 4000),
    options: value.options.map((option) => {
      if (
        !isRecord(option) ||
        Object.keys(option).some((k) => !["id", "label", "actionId"].includes(k)) ||
        typeof option.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(option.id) ||
        ids.has(option.id) ||
        (option.actionId !== undefined &&
          (typeof option.actionId !== "string" || !botTaskActions(task).some((a) => a.id === option.actionId)))
      )
        throw new BotError("invalidReview");
      ids.add(option.id);
      return {
        id: option.id,
        label: botText(option.label, 240),
        ...(typeof option.actionId === "string" ? { actionId: option.actionId } : {}),
      };
    }),
  };
}
export function completeBotAction(task: BotTask, actionId: string) {
  const action = botTaskAction(task, actionId);
  if (actionId !== "complete" && !action) throw new BotError("invalidAction");
  if (task.input.actions === undefined && actionId === "discard" && !action?.callback)
    throw new BotError("callbackRequired", 409);
  task.decision = actionId;
  if (task.input.actions !== undefined && action) task.decisionLabel = action.label;
  else delete task.decisionLabel;
  task.status = action?.callback
    ? "queued"
    : task.input.actions === undefined && actionId === "keep"
      ? "kept"
      : "completed";
  task.callbackStatus = action?.callback ? "pending" : "not-required";
  delete task.failure;
  delete task.review;
}

/** Matching replays are safe; an old or conflicting answer cannot approve a newer question. */
export function applyBotReview(task: BotTask, value: BotReviewAnswer | string) {
  if (typeof value === "string") {
    if (!["review", "callback_failed", "callback_unknown"].includes(task.status))
      throw new BotError("invalidState", 409);
    if (task.status === "review" && task.review) throw new BotError("invalidReview");
    if (task.status !== "review" && value !== task.decision) throw new BotError("invalidAction", 409);
    completeBotAction(task, value);
    return { duplicate: false, detail: value };
  }
  if (!isRecord(value) || Object.keys(value).some((k) => !["reviewId", "optionId", "message"].includes(k)))
    throw new BotError("invalidReview");
  const reviewId = botText(value.reviewId, 200),
    optionId = value.optionId === undefined ? undefined : botText(value.optionId, 64),
    message = value.message === undefined ? undefined : botText(value.message, 4000, true) || undefined;
  if (!optionId && !message) throw new BotError("reviewAnswerRequired");
  const previous = task.reviewHistory?.find((review) => review.id === reviewId);
  if (previous) {
    if (previous.answer.optionId === optionId && previous.answer.message === message)
      return { duplicate: true, detail: "" };
    throw new BotError("staleReview", 409);
  }
  const review = botTaskReview(task);
  if (task.status !== "review" || review.id !== reviewId) throw new BotError("staleReview", 409);
  const option = optionId ? review.options.find((o) => o.id === optionId) : undefined;
  if (optionId && !option) throw new BotError("invalidReview");
  task.reviewHistory = [
    ...(task.reviewHistory ?? []).slice(-19),
    {
      ...review,
      answer: { ...(optionId ? { optionId } : {}), ...(message ? { message } : {}), at: Date.now() },
    },
  ];
  // A note can qualify the choice, so it must be interpreted before any external action is sent.
  if (option?.actionId && !message) completeBotAction(task, option.actionId);
  else {
    task.status = "queued";
    task.decision = null;
    delete task.decisionLabel;
    delete task.review;
    delete task.failure;
    task.callbackStatus = "not-required";
    task.runId = null;
  }
  task.reason = message || option?.label || task.reason;
  return { duplicate: false, detail: JSON.stringify({ review, answer: { optionId, message, label: option?.label } }) };
}
