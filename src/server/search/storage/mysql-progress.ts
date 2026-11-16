import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import type { SearchBuildPhase, SearchBuildProgress } from "../../../shared/search/contracts.js";
import type { SearchJobRow } from "../state.js";
type ProgressRow = Omit<SearchBuildProgress, "job"> & {
  requested: number;
  token: string;
};
export type BuildUpdate = Pick<SearchBuildProgress, "completed" | "total"> & {
  phase: Exclude<SearchBuildPhase, "queued" | "ready" | "failed">;
};
const stages = { reading: 1, text: 2, knowledge: 3, vector: 4, activating: 5 };
/** Progress is bounded durable job metadata, fenced by the exact request and worker lease. */
export class MySQLSearchProgressStore {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  async start(row: SearchJobRow) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        `INSERT INTO panda_force_search_progress VALUES(?,?,?,'reading',0,NULL,?,?,NULL)
      ON DUPLICATE KEY UPDATE token=VALUES(token),phase='reading',completed=0,total=NULL,
      startedAt=CASE WHEN requested=VALUES(requested) THEN startedAt ELSE VALUES(startedAt) END,
      requested=VALUES(requested),updatedAt=VALUES(updatedAt),finishedAt=NULL`,
        [row.key, row.requested, row.token, this.now(), this.now()],
      );
    });
  }
  async update(row: SearchJobRow, value: BuildUpdate) {
    return await this.db.atomic(async () => {
      if (
        !stages[value.phase] ||
        !Number.isSafeInteger(value.completed) ||
        value.completed < 0 ||
        (value.total !== null && (!Number.isSafeInteger(value.total) || value.total < value.completed))
      )
        return false;
      return (
        (
          await this.db.execute(
            `UPDATE panda_force_search_progress SET phase=?,completed=?,total=?,updatedAt=?
      WHERE \`key\`=? AND token=? AND requested=? AND finishedAt IS NULL
      AND CASE phase WHEN 'reading' THEN 1 WHEN 'text' THEN 2 WHEN 'knowledge' THEN 3 WHEN 'vector' THEN 4 WHEN 'activating' THEN 5 ELSE 9 END<=?
      AND (phase!=? OR completed<=?)
      AND EXISTS(SELECT 1 FROM panda_force_search_scopes s WHERE s.\`key\`=panda_force_search_progress.\`key\` AND s.token=? AND s.requested=? AND s.revision=? AND s.state='running')`,
            [
              value.phase,
              value.completed,
              value.total,
              this.now(),
              row.key,
              row.token,
              row.requested,
              stages[value.phase],
              value.phase,
              value.completed,
              row.token,
              row.requested,
              row.revision,
            ],
          )
        ).changes === 1
      );
    });
  }
  async finish(row: SearchJobRow, phase: "ready" | "failed") {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_search_progress SET phase=?,updatedAt=?,finishedAt=? WHERE `key`=? AND token=? AND requested=?",
        [phase, this.now(), this.now(), row.key, row.token, row.requested],
      );
    });
  }
  async view(row: SearchJobRow | null): Promise<SearchBuildProgress | null> {
    return await this.db.atomic(async () => {
      if (!row || row.state === "disabled" || row.state === "needsReview") return null;
      const p = await this.db.one<ProgressRow>("SELECT * FROM panda_force_search_progress WHERE `key`=?", [row.key]);
      if (!p || p.requested !== row.requested)
        return row.state === "queued" || row.state === "running"
          ? {
              job: row.key + ":" + row.requested,
              phase: "queued",
              completed: 0,
              total: null,
              startedAt: null,
              updatedAt: row.updatedAt,
              finishedAt: null,
            }
          : null;
      if (
        !["reading", "text", "knowledge", "vector", "activating", "ready", "failed"].includes(p.phase) ||
        !Number.isSafeInteger(p.completed) ||
        p.completed < 0 ||
        (p.total !== null && (!Number.isSafeInteger(p.total) || p.total < p.completed)) ||
        !Number.isSafeInteger(p.startedAt) ||
        !Number.isSafeInteger(p.updatedAt) ||
        (p.finishedAt !== null && !Number.isSafeInteger(p.finishedAt))
      )
        return null;
      return {
        job: row.key + ":" + row.requested,
        phase: p.phase,
        completed: p.completed,
        total: p.total,
        startedAt: p.startedAt,
        updatedAt: p.updatedAt,
        finishedAt: p.finishedAt,
      };
    });
  }
}
