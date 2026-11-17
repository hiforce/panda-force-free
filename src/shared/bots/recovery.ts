import type { BotTaskSummary } from "./contracts.js";

/** Callback retries and human business decisions require their own explicit confirmation. */
export function botCanRetryExecution(task: Pick<BotTaskSummary, "status" | "failure" | "decision">): boolean {
  return task.status === "review" && task.failure === "execution" && !task.decision;
}
