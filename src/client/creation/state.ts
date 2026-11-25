import type { CreationTaskView, CreationTaskState } from "../../shared/creation/contracts.js";
import type { MessageId } from "../../shared/i18n/messages.js";

export const creationStateLabels = {
  queued: "creation.queued",
  running: "creation.running",
  committing: "creation.committing",
  succeeded: "creation.succeeded",
  replied: "creation.replied",
  failed: "creation.failed",
  cancelled: "creation.cancelled",
} as const satisfies Record<CreationTaskState, MessageId>;
export function creationCanUpdate(task?: CreationTaskView): boolean {
  return Boolean(task && !task.cancelRequested && (task.state === "queued" || task.state === "running"));
}
export function creationStateMessage(task: CreationTaskView): MessageId {
  if (task.goal?.status === "paused") return "common.goalPaused";
  if (task.question) return "creation.waiting";
  if (task.failure) return task.failure === "targetChanged" ? "creation.reviewRequired" : "creation.failed";
  if (task.state === "succeeded" && task.artifact && task.artifact.kind !== "document") return "creative.saved";
  return creationStateLabels[task.state];
}
