import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import type { Database } from "bun:sqlite";
import { KNOWLEDGE_LIMITS, type KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import { KnowledgeTaskError, type KnowledgeTaskReads, type KnowledgeTaskRow } from "../tasks/contracts.js";
import type { KnowledgeTaskPosition } from "../tasks/contracts.js";
export type StoredTask = Omit<KnowledgeTaskRow, "result"> & {
  result: string | null;
  ruleDocument?: string | null;
  ruleKind?: SavedSourceKind | null;
  ruleVersion?: string;
  ruleRevision?: number;
  ruleManual?: number;
};
const taskWithOrigin = `SELECT t.*,g.documentId AS ruleDocument,g.sourceKind AS ruleKind,g.version AS ruleVersion,
  g.policyRevision AS ruleRevision,g.manual AS ruleManual FROM knowledge_tasks t
  LEFT JOIN knowledge_generation_origins g ON g.taskId=t.id AND g.owner=t.owner AND g.project=t.project`;
export function decodeTask(value: StoredTask): KnowledgeTaskRow {
  const { ruleDocument, ruleKind, ruleVersion, ruleRevision, ruleManual, ...task } = value;
  return {
    ...task,
    result: task.result === null ? null : (JSON.parse(task.result) as KnowledgeReceipt),
    ...(ruleDocument
      ? {
          origin: {
            kind: "rule" as const,
            ...(ruleKind === "web" || ruleKind === "slides"
              ? { sourceId: ruleDocument, sourceKind: ruleKind }
              : { documentId: ruleDocument }),
            version: ruleVersion!,
            policyRevision: ruleRevision!,
            manual: ruleManual === 1,
          },
        }
      : {}),
  };
}

/** Owns records metadata transitions on the application's one transactional connection. */
export class KnowledgeTaskRecords implements KnowledgeTaskReads {
  constructor(private readonly db: Database) {}
  get(owner: string, id: string): KnowledgeTaskRow {
    const value = this.db
      .query<StoredTask, [string, string]>(taskWithOrigin + " WHERE t.owner=? AND t.id=?")
      .get(owner, id);
    if (!value) throw new KnowledgeTaskError("notFound");
    return decodeTask(value);
  }

  list(owner: string, project: string, limit: number = KNOWLEDGE_LIMITS.pageSize): KnowledgeTaskRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.pageSize)
      throw new KnowledgeTaskError("invalidInput");
    return this.db
      .query<StoredTask, [string, string, number]>(
        taskWithOrigin + " WHERE t.owner=? AND t.project=? ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
      )
      .all(owner, project, limit)
      .map(decodeTask);
  }
  page(owner: string, project: string, position?: KnowledgeTaskPosition, limit: number = KNOWLEDGE_LIMITS.pageSize) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.pageSize)
      throw new KnowledgeTaskError("invalidInput");
    return this.db
      .transaction(() => {
        const watermark =
          position?.watermark ??
          this.db
            .query<{ rowid: number; id: string }, [string, string]>(
              "SELECT rowid,id FROM knowledge_tasks WHERE owner=? AND project=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(owner, project);
        if (!watermark) return { tasks: [], next: null };
        if (
          position &&
          !this.db
            .query("SELECT 1 FROM knowledge_tasks WHERE rowid=? AND id=? AND owner=? AND project=?")
            .get(watermark.rowid, watermark.id, owner, project)
        )
          throw new KnowledgeTaskError("conflict");
        const rows = position
          ? this.db
              .query<StoredTask, [string, string, number, number, number, string, number]>(
                taskWithOrigin +
                  " WHERE t.owner=? AND t.project=? AND t.rowid<=? AND (t.createdAt<? OR (t.createdAt=? AND t.id<?)) ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
              )
              .all(owner, project, watermark.rowid, position.createdAt, position.createdAt, position.id, limit + 1)
          : this.db
              .query<StoredTask, [string, string, number, number]>(
                taskWithOrigin +
                  " WHERE t.owner=? AND t.project=? AND t.rowid<=? ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
              )
              .all(owner, project, watermark.rowid, limit + 1);
        const more = rows.length > limit;
        if (more) rows.pop();
        const last = rows.at(-1);
        return {
          tasks: rows.map(decodeTask),
          next: more && last ? { createdAt: last.createdAt, id: last.id, watermark } : null,
        };
      })
      .deferred();
  }

  submission(owner: string, operationId: string, requestHash: string): KnowledgeTaskRow | null {
    const prior = this.db
      .query<{ taskId: string; requestHash: string }, [string, string]>(
        "SELECT taskId,requestHash FROM knowledge_submissions WHERE owner=? AND operationId=?",
      )
      .get(owner, operationId);
    if (!prior) return null;
    if (prior.requestHash !== requestHash) throw new KnowledgeTaskError("conflict");
    return this.get(owner, prior.taskId);
  }
}
