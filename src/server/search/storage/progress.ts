import type { Database } from "bun:sqlite";
import type { SearchBuildPhase, SearchBuildProgress } from "../../../shared/search/contracts.js";
import type { SearchJobRow } from "../state.js";

type ProgressRow = Omit<SearchBuildProgress, "job"> & { requested: number; token: string };
export type BuildUpdate = Pick<SearchBuildProgress, "completed" | "total"> & {
  phase: Exclude<SearchBuildPhase, "queued" | "ready" | "failed">;
};
const stages = { reading: 1, text: 2, knowledge: 3, vector: 4, activating: 5 };
/** Progress is bounded durable job metadata, fenced by the exact request and worker lease. */
export class SearchProgressStore {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  start(row: SearchJobRow) {
    this.db
      .query(
        `INSERT INTO search_progress VALUES(?,?,?,'reading',0,NULL,?,?,NULL)
      ON CONFLICT(key) DO UPDATE SET token=excluded.token,phase='reading',completed=0,total=NULL,
      startedAt=CASE WHEN requested=excluded.requested THEN startedAt ELSE excluded.startedAt END,
      requested=excluded.requested,updatedAt=excluded.updatedAt,finishedAt=NULL`,
      )
      .run(row.key, row.requested, row.token, this.now(), this.now());
  }
  update(row: SearchJobRow, value: BuildUpdate) {
    if (
      !stages[value.phase] ||
      !Number.isSafeInteger(value.completed) ||
      value.completed < 0 ||
      (value.total !== null && (!Number.isSafeInteger(value.total) || value.total < value.completed))
    )
      return false;
    return (
      this.db
        .query(
          `UPDATE search_progress SET phase=?,completed=?,total=?,updatedAt=?
      WHERE key=? AND token=? AND requested=? AND finishedAt IS NULL
      AND CASE phase WHEN 'reading' THEN 1 WHEN 'text' THEN 2 WHEN 'knowledge' THEN 3 WHEN 'vector' THEN 4 WHEN 'activating' THEN 5 ELSE 9 END<=?
      AND (phase!=? OR completed<=?)
      AND EXISTS(SELECT 1 FROM search_scopes s WHERE s.key=search_progress.key AND s.token=? AND s.requested=? AND s.revision=? AND s.state='running')`,
        )
        .run(
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
        ).changes === 1
    );
  }
  finish(row: SearchJobRow, phase: "ready" | "failed") {
    this.db
      .query("UPDATE search_progress SET phase=?,updatedAt=?,finishedAt=? WHERE key=? AND token=? AND requested=?")
      .run(phase, this.now(), this.now(), row.key, row.token, row.requested);
  }
  view(row: SearchJobRow | null): SearchBuildProgress | null {
    if (!row || row.state === "disabled" || row.state === "needsReview") return null;
    const p = this.db.query<ProgressRow, [string]>("SELECT * FROM search_progress WHERE key=?").get(row.key);
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
  }
}
