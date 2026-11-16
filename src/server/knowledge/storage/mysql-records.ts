import { mysqlInteger } from "../../database/mysql-model.js";
import type { MySQLMetadataContext } from "./mysql-context.js";

import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import { KNOWLEDGE_LIMITS, type KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import { KnowledgeTaskError, type KnowledgeTaskRow } from "../tasks/contracts.js";
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
  g.policyRevision AS ruleRevision,g.manual AS ruleManual FROM panda_force_knowledge_tasks t
  LEFT JOIN panda_force_knowledge_generation_origins g ON g.taskId=t.id AND g.owner=t.owner AND g.project=t.project`;
export function decodeTask(value: StoredTask): KnowledgeTaskRow {
  const {
    ruleDocument,
    ruleKind,
    ruleVersion,
    ruleRevision,
    ruleManual,
    rowSequence: _sequence,
    ...task
  } = value as StoredTask & {
    rowSequence?: number;
  };
  return {
    ...task,
    generation: mysqlInteger(task.generation),
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
export class MySQLKnowledgeTaskRecords {
  constructor(private readonly db: MySQLMetadataContext) {}
  async get(owner: string, id: string): Promise<KnowledgeTaskRow> {
    return await this.db.atomic(async () => {
      const value = await this.db.one<StoredTask>(taskWithOrigin + " WHERE t.owner=? AND t.id=?", [owner, id]);
      if (!value) throw new KnowledgeTaskError("notFound");
      return decodeTask(value);
    });
  }
  async list(owner: string, project: string, limit: number = KNOWLEDGE_LIMITS.pageSize): Promise<KnowledgeTaskRow[]> {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.pageSize)
        throw new KnowledgeTaskError("invalidInput");
      return (
        await this.db.all<StoredTask>(
          taskWithOrigin + " WHERE t.owner=? AND t.project=? ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
          [owner, project, limit],
        )
      ).map(decodeTask);
    });
  }
  async page(
    owner: string,
    project: string,
    position?: KnowledgeTaskPosition,
    limit: number = KNOWLEDGE_LIMITS.pageSize,
  ) {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.pageSize)
        throw new KnowledgeTaskError("invalidInput");
      return await this.db.atomic(async () => {
        const watermark =
          position?.watermark ??
          (await this.db.one<{
            rowid: number;
            id: string;
          }>(
            "SELECT rowSequence AS rowid,id FROM panda_force_knowledge_tasks WHERE owner=? AND project=? ORDER BY rowSequence DESC LIMIT 1",
            [owner, project],
          ));
        if (!watermark) return { tasks: [], next: null };
        if (
          position &&
          !(await this.db.one(
            "SELECT 1 FROM panda_force_knowledge_tasks WHERE rowSequence=? AND id=? AND owner=? AND project=?",
            [watermark.rowid, watermark.id, owner, project],
          ))
        )
          throw new KnowledgeTaskError("conflict");
        const rows = position
          ? await this.db.all<StoredTask>(
              taskWithOrigin +
                " WHERE t.owner=? AND t.project=? AND t.rowSequence<=? AND (t.createdAt<? OR (t.createdAt=? AND t.id<?)) ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
              [owner, project, watermark.rowid, position.createdAt, position.createdAt, position.id, limit + 1],
            )
          : await this.db.all<StoredTask>(
              taskWithOrigin +
                " WHERE t.owner=? AND t.project=? AND t.rowSequence<=? ORDER BY t.createdAt DESC,t.id DESC LIMIT ?",
              [owner, project, watermark.rowid, limit + 1],
            );
        const more = rows.length > limit;
        if (more) rows.pop();
        const last = rows.at(-1);
        return {
          tasks: rows.map(decodeTask),
          next: more && last ? { createdAt: last.createdAt, id: last.id, watermark } : null,
        };
      });
    });
  }
  async submission(owner: string, operationId: string, requestHash: string): Promise<KnowledgeTaskRow | null> {
    return await this.db.atomic(async () => {
      const prior = await this.db.one<{
        taskId: string;
        requestHash: string;
      }>("SELECT taskId,requestHash FROM panda_force_knowledge_submissions WHERE owner=? AND operationId=?", [
        owner,
        operationId,
      ]);
      if (!prior) return null;
      if (prior.requestHash !== requestHash) throw new KnowledgeTaskError("conflict");
      return await this.get(owner, prior.taskId);
    });
  }
}
