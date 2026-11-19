import { isRecord } from "../../shared/records.js";
import { BotError, type BotTask, type BotBulkDeleteResult } from "../../shared/bots/contracts.js";
import { botHasCallbackDecision } from "../../shared/bots/actions.js";

export function botDeleteInput(value: unknown, external: boolean) {
  const field = external ? "idempotencyKeys" : "taskIds";
  if (!isRecord(value) || Object.keys(value).some((key) => key !== field)) throw new BotError("invalidInput");
  const keys = value[field];
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 500 ||
    keys.some(
      (key) => typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > (external ? 256 : 128),
    ) ||
    new Set(keys).size !== keys.length
  )
    throw new BotError("invalidInput");
  return [...(keys as string[])].sort();
}

export function callbackInFlight(task: BotTask) {
  return task.status === "callback_unknown" || (task.status === "running" && botHasCallbackDecision(task));
}

export function deleteResult(requested: number): BotBulkDeleteResult {
  return { requested, deleted: 0, alreadyDeleted: 0, blocked: [], interrupted: [] };
}
