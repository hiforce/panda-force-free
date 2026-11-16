import type { BotDecision, BotTask, BotTaskStatus, BotTaskState, BotCallbackStatus } from "./contracts.js";
import { botHasCallbackDecision, botTaskAction } from "./actions.js";
export const BOT_TASK_STATES = ["created", "running", "finished", "suspended", "canceled", "error"] as const;
type TaskStateInput = {
  status: BotTaskStatus;
  decision?: BotDecision | null;
  failure?: "execution";
  callbackStatus?: BotCallbackStatus;
  input?: BotTask["input"];
};
/** Execution lifecycle, business decisions and delivery acknowledgments are independent dimensions. */
export function botTaskState(task: TaskStateInput): BotTaskState {
  if (task.status === "queued") return "created";
  if (task.status === "running") return "running";
  if (task.status === "canceled") return "canceled";
  if (["kept", "discarded", "completed"].includes(task.status)) return "finished";
  if (task.status === "callback_failed" || (task.status === "review" && task.failure === "execution")) return "error";
  return "suspended";
}
export function botCallbackStatus(task: TaskStateInput): BotCallbackStatus {
  if (task.status === "discarded") return "succeeded";
  if (task.status === "completed") return task.callbackStatus === "succeeded" ? "succeeded" : "not-required";
  if (task.status === "callback_failed") return "failed";
  if (task.status === "callback_unknown") return "unknown";
  const hasCallback = task.input
    ? botHasCallbackDecision({ input: task.input, decision: task.decision ?? null })
    : task.decision === "discard" || ["pending", "not-sent", "not-configured"].includes(task.callbackStatus ?? "");
  if (!hasCallback) return "not-required";
  if (task.status === "canceled")
    return task.callbackStatus && ["failed", "unknown", "succeeded"].includes(task.callbackStatus)
      ? task.callbackStatus
      : "not-sent";
  if (["queued", "running", "suspended"].includes(task.status)) return "pending";
  if (task.input) return botTaskAction({ input: task.input }, task.decision)?.callback ? "not-sent" : "not-configured";
  return task.callbackStatus === "not-sent" ? "not-sent" : "not-configured";
}
export function botTaskView(task: BotTask) {
  return { ...task, state: botTaskState(task), callbackStatus: botCallbackStatus(task) };
}

export function botTaskDecision(task: TaskStateInput): BotDecision | null {
  return (
    task.decision ||
    (task.status === "kept"
      ? "keep"
      : ["discarded", "callback_failed", "callback_unknown"].includes(task.status)
        ? "discard"
        : null)
  );
}
