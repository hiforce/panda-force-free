import { createHash } from "node:crypto";
import { isRecord } from "../../shared/records.js";
import { BotError, type BotBulkRetryRequest, type BotBulkRetryResult } from "../../shared/bots/contracts.js";

export function botRecoveryInput(value: unknown): BotBulkRetryRequest & { signature: string } {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["id", "taskIds"].includes(key)) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !Array.isArray(value.taskIds) ||
    !value.taskIds.length ||
    value.taskIds.length > 500 ||
    value.taskIds.some((id) => typeof id !== "string" || !uuid.test(id)) ||
    new Set(value.taskIds).size !== value.taskIds.length
  )
    throw new BotError("invalidInput");
  const taskIds = (value.taskIds as string[]).slice().sort();
  return { id: value.id, taskIds, signature: createHash("sha256").update(JSON.stringify(taskIds)).digest("hex") };
}
export function botRecoveryReplay(row: { signature: string; result: string }, signature: string): BotBulkRetryResult {
  if (row.signature !== signature) throw new BotError("idempotencyConflict", 409);
  return JSON.parse(row.result) as BotBulkRetryResult;
}
