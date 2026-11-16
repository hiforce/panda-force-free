import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { CreationError, type CreationFailure, type CreationTask, type CreationTaskState } from "../contracts.js";
import { creationArtifact, creationTaskSpec } from "../validation.js";
import { creationText, creationUuid } from "../validation.js";
import type { Database } from "bun:sqlite";

export interface CreationTaskRow {
  id: string;
  owner: string;
  projectId: string;
  operationId: string;
  spec: string;
  signature: string;
  state: CreationTaskState;
  generation: number;
  attempts: number;
  budget: number;
  token: string | null;
  leaseUntil: number | null;
  sessionId: string | null;
  runId: string | null;
  cancelRequested: number;
  outputDigest: string | null;
  artifact: string | null;
  failure: CreationFailure | null;
  createdAt: number;
  updatedAt: number;
}
export function readCreationTask(db: Database, owner: string, id: string): CreationTaskRow {
  const row = db
    .query<CreationTaskRow, [string, string]>("SELECT * FROM creation_tasks WHERE owner=? AND id=?")
    .get(creationText(owner), creationUuid(id));
  if (!row) throw new CreationError("notFound");
  creationTask(row);
  return row;
}
export const creationSignature = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export function creationTask(row: CreationTaskRow): CreationTask {
  try {
    const spec = creationTaskSpec(JSON.parse(row.spec));
    if (
      creationSignature(spec) !== row.signature ||
      spec.id !== row.id ||
      spec.owner !== row.owner ||
      spec.projectId !== row.projectId ||
      spec.operationId !== row.operationId
    )
      throw new CreationError("unavailable");
    return {
      spec,
      state: row.state,
      generation: row.generation,
      attempts: row.attempts,
      cancelRequested: row.cancelRequested === 1,
      outputDigest: row.outputDigest,
      artifact: row.artifact === null ? null : creationArtifact(JSON.parse(row.artifact), spec),
      failure: row.failure,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    throw new CreationError("unavailable");
  }
}
