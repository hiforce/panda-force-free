import { mysqlInteger } from "../../database/mysql-model.js";
import { CreationError } from "../contracts.js";
import type { CreationMessageRecord } from "../messages/contracts.js";
import type { CreationQuestionRecord } from "../questions/contracts.js";
import type { CreationLineageRow, CreationRoundRow } from "./lineage.js";
import type { CreationTaskRow } from "./records.js";
type Row = Record<string, unknown>;
const text = (v: unknown): string => {
  if (typeof v !== "string") throw new CreationError("unavailable");
  return v;
};
const nullableText = (v: unknown) => (v === null ? null : text(v));
const nullableInteger = (v: unknown) => (v === null ? null : mysqlInteger(v));
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  for (const choice of choices) if (choice === v) return choice;
  throw new CreationError("unavailable");
}
export function mysqlCreationTaskRow(row: Row): CreationTaskRow {
  return {
    id: text(row.id),
    owner: text(row.owner),
    projectId: text(row.projectId),
    operationId: text(row.operationId),
    spec: text(row.spec),
    signature: text(row.signature),
    state: choice(row.state, ["queued", "running", "committing", "succeeded", "failed", "cancelled"]),
    generation: mysqlInteger(row.generation),
    attempts: mysqlInteger(row.attempts),
    budget: mysqlInteger(row.budget),
    token: nullableText(row.token),
    leaseUntil: nullableInteger(row.leaseUntil),
    sessionId: nullableText(row.sessionId),
    runId: nullableText(row.runId),
    cancelRequested: mysqlInteger(row.cancelRequested),
    outputDigest: nullableText(row.outputDigest),
    artifact: nullableText(row.artifact),
    failure:
      row.failure === null
        ? null
        : choice(row.failure, [
            "interrupted",
            "timedOut",
            "inactive",
            "invalidOutput",
            "targetChanged",
            "fileChanged",
            "writeUnavailable",
          ]),
    createdAt: mysqlInteger(row.createdAt),
    updatedAt: mysqlInteger(row.updatedAt),
  };
}
export function mysqlCreationMessageRow(row: Row): CreationMessageRecord {
  return {
    id: text(row.id),
    owner: text(row.owner),
    taskId: text(row.taskId),
    generation: mysqlInteger(row.generation),
    requestDigest: text(row.requestDigest),
    payloadDigest: text(row.payloadDigest),
    state: choice(row.state, ["received", "dispatching", "delivered", "uncertain"]),
    dispatchGeneration: nullableInteger(row.dispatchGeneration),
    createdAt: mysqlInteger(row.createdAt),
    updatedAt: mysqlInteger(row.updatedAt),
  };
}
export function mysqlCreationQuestionRow(row: Row): CreationQuestionRecord {
  return {
    id: text(row.id),
    owner: text(row.owner),
    taskId: text(row.taskId),
    generation: mysqlInteger(row.generation),
    questionDigest: text(row.questionDigest),
    answerDigest: nullableText(row.answerDigest),
    state: choice(row.state, ["pending", "answered", "expired"]),
    createdAt: mysqlInteger(row.createdAt),
    answeredAt: nullableInteger(row.answeredAt),
  };
}
export function mysqlCreationRoundRow(row: Row): CreationRoundRow {
  return {
    id: text(row.id),
    createdAt: mysqlInteger(row.createdAt),
    creationRootId: text(row.creationRootId),
    creationCreatedAt: mysqlInteger(row.creationCreatedAt),
    creationRounds: mysqlInteger(row.creationRounds),
    ...(row.latestTaskId === undefined ? {} : { latestTaskId: text(row.latestTaskId) }),
  };
}
export function mysqlCreationLineageRow(row: Row): CreationLineageRow {
  return { ...mysqlCreationTaskRow(row), ...mysqlCreationRoundRow(row) };
}
