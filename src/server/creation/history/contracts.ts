import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import type { CreationTask } from "../contracts.js";
import { CreationError } from "../contracts.js";
import { creationInteger, creationRecord, creationUuid } from "../validation.js";
export interface CreationHistoryCommand {
  id: string;
  taskId?: string;
  before?: number;
}
export interface CreationHistoryReceipt {
  id: string;
  hidden: number;
}
export function creationHistoryCommand(value: unknown): CreationHistoryCommand {
  const row = creationRecord(value, ["id", "taskId", "before"]);
  return {
    id: creationUuid(row.id),
    ...(row.taskId === undefined ? {} : { taskId: creationUuid(row.taskId) }),
    ...(row.before === undefined ? {} : { before: creationInteger(row.before) }),
  };
}
export const historySignature = (command: CreationHistoryCommand) =>
  createHash("sha256").update(stableJson(command)).digest("hex");
export const historyDocument = (task: CreationTask) =>
  task.spec.target.document?.documentId || (task.artifact?.kind === "document" ? task.artifact.documentId : null);
export function historyReceipt(value: string, id: string): CreationHistoryReceipt {
  const row = creationRecord(JSON.parse(value), ["id", "hidden"]);
  if (row.id !== id) throw new CreationError("unavailable");
  return { id, hidden: creationInteger(row.hidden) };
}

export interface CreationHistoryTask extends CreationTask {
  history?: { rootId: string; createdAt: number; rounds: number };
}
export interface CreationRoundPage {
  ids: string[];
  latestTaskId: string;
  rootId: string;
  createdAt: number;
  rounds: number;
  nextCursor: string | null;
}
