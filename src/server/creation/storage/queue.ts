import {
  creationLineageSql,
  creationHeadOrder,
  creationHistoryTask,
  creationRoundCursor,
  creationRoundPage,
  type CreationLineageRow,
} from "./lineage.js";
import {
  creationHistoryCommand,
  historyReceipt,
  historySignature,
  type CreationHistoryCommand,
} from "../history/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { Database } from "bun:sqlite";
import type { CreationLease, CreationFailure } from "../contracts.js";
import { CreationError } from "../contracts.js";
import { creationId, creationInteger, creationUuid, creationText } from "../validation.js";
import type { CreationTaskRepository } from "./repository.js";
import { readCreationTask, creationTask, creationSignature, type CreationTaskRow } from "./records.js";
import { creationReplyProgress, SQLiteCreationProgress } from "./progress.js";

/** Scheduling and explicit user actions share short metadata transactions, never a model process or a Git write. */
export class CreationQueue {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<CreationTaskRepository, "get" | "claim">,
  ) {}
  claim(now: number, leaseMs = 30000) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        this.db
          .query(
            `UPDATE creation_tasks SET state='failed',failure='interrupted',token=NULL,leaseUntil=NULL,updatedAt=?
        WHERE state='running' AND leaseUntil<=? AND budget<=0 AND outputDigest IS NULL
        AND NOT EXISTS(SELECT 1 FROM creation_questions WHERE taskId=creation_tasks.id AND state='pending')`,
          )
          .run(now, now);
        const row = this.db
          .query<CreationTaskRow, [number]>(
            `SELECT * FROM creation_tasks WHERE outputDigest IS NULL AND cancelRequested=0 AND budget>0
        AND (state='queued' OR (state='running' AND leaseUntil<=?))
        AND NOT EXISTS(SELECT 1 FROM creation_questions WHERE taskId=creation_tasks.id AND state='pending')
        ORDER BY createdAt,id LIMIT 1`,
          )
          .get(now);
        if (!row) return null;
        const lease = this.tasks.claim(row.owner, row.id, now, leaseMs);
        return { lease, task: this.tasks.get(row.owner, row.id) };
      })
      .immediate();
  }
  private matches(row: CreationTaskRow, lease: CreationLease) {
    return (
      row.state === "running" &&
      row.token === lease.token &&
      row.generation === lease.generation &&
      row.outputDigest === null
    );
  }
  release(lease: CreationLease, now: number) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, lease.owner, lease.taskId);
        if (!this.matches(row, lease)) return false;
        // Keep unanswered questions available while no engine process is attached.
        this.db
          .query(
            "UPDATE creation_tasks SET state='queued',token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          )
          .run(now, row.id);
        return true;
      })
      .immediate();
  }
  fail(lease: CreationLease, failure: CreationFailure, now: number) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, lease.owner, lease.taskId);
        if (!this.matches(row, lease)) return false;
        this.db.query("UPDATE creation_questions SET state='expired' WHERE taskId=? AND state='pending'").run(row.id);
        this.db
          .query("UPDATE creation_tasks SET state='failed',failure=?,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?")
          .run(failure, now, row.id);
        return true;
      })
      .immediate();
  }
  reply(lease: CreationLease, text: string, now: number) {
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, lease.owner, lease.taskId);
        if (!this.matches(row, lease) || row.cancelRequested || (row.leaseUntil ?? 0) <= now) return false;
        if (
          this.db.query("SELECT 1 FROM creation_messages WHERE taskId=? AND state<>'delivered' LIMIT 1").get(row.id) ||
          this.db.query("SELECT 1 FROM creation_questions WHERE taskId=? AND state='pending' LIMIT 1").get(row.id)
        )
          return false;
        new SQLiteCreationProgress(this.db).record(lease, creationReplyProgress(lease, text, now));
        this.db
          .query(
            "UPDATE creation_tasks SET state='replied',failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",
          )
          .run(now, row.id);
        return true;
      })
      .immediate();
  }
  retry(owner: string, id: string, operationId: string, now: number) {
    creationUuid(operationId);
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, owner, id),
          request = creationSignature({ action: "retry", taskId: id }),
          prior = this.db
            .query<{ owner: string; request: string }, [string]>(
              "SELECT owner,request FROM creation_actions WHERE id=?",
            )
            .get(operationId);
        if (prior) {
          if (prior.owner !== owner) throw new CreationError("notFound");
          if (prior.request !== request) throw new CreationError("conflict");
          return creationTask(row);
        }
        if (
          row.artifact !== null ||
          !(row.state === "failed" || row.state === "cancelled" || (row.state === "committing" && row.failure !== null))
        )
          throw new CreationError("conflict");
        if (row.outputDigest === null) {
          const active = this.db
            .query<{ own: number; total: number }, [string]>(
              "SELECT COALESCE(SUM(owner=?),0) AS own,COUNT(*) AS total FROM creation_tasks WHERE state IN('queued','running','committing')",
            )
            .get(owner)!;
          if (active.own >= 32 || active.total >= 256) throw new CreationError("unavailable");
          this.db
            .query(
              "UPDATE creation_tasks SET state='queued',budget=3,cancelRequested=0,failure=NULL,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
            )
            .run(now, id);
        } else this.db.query("UPDATE creation_tasks SET failure=NULL,updatedAt=? WHERE id=?").run(now, id);
        this.db
          .query("INSERT INTO creation_actions(id,owner,taskId,request,createdAt) VALUES(?,?,?,?,?)")
          .run(operationId, owner, id, request, now);
        return this.tasks.get(owner, id);
      })
      .immediate();
  }
  clearHistory(owner: string, command: CreationHistoryCommand, now: number) {
    command = creationHistoryCommand(command);
    owner = creationText(owner, 200);
    creationInteger(now);
    const signature = historySignature(command);
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<{ owner: string; request: string; result: string }, [string]>(
            "SELECT owner,request,result FROM creation_history_actions WHERE id=?",
          )
          .get(command.id);
        if (prior) {
          if (prior.owner !== owner) throw new CreationError("notFound");
          if (prior.request !== signature) throw new CreationError("conflict");
          return historyReceipt(prior.result, command.id);
        }
        const task = command.taskId ? this.tasks.get(owner, command.taskId) : null;
        const rows = this.db
          .query<{ id: string }, (string | number)[]>(
            task
              ? creationLineageSql(false, true) +
                  `SELECT id FROM identified WHERE historyKey=(SELECT historyKey FROM identified WHERE id=?)` +
                  (command.before === undefined ? "" : " AND createdAt<?")
              : `SELECT id FROM creation_tasks WHERE owner=?` +
                  (command.before === undefined ? "" : " AND createdAt<?"),
          )
          .all(
            ...(task ? [owner, task.spec.projectId, task.spec.id] : [owner]),
            ...(command.before === undefined ? [] : [command.before]),
          );
        let hidden = 0;
        const hide = this.db.query("INSERT OR IGNORE INTO creation_history_hidden(id,owner) VALUES(?,?)");
        for (const row of rows) hidden += hide.run(row.id, owner).changes;
        const result = { id: command.id, hidden };
        this.db
          .query("INSERT INTO creation_history_actions(id,owner,request,result,createdAt) VALUES(?,?,?,?,?)")
          .run(command.id, owner, signature, stableJson(result), now);
        return result;
      })
      .immediate();
  }
  list(owner: string, projectId?: string) {
    if (projectId !== undefined) creationId(projectId);
    return this.db
      .query<CreationLineageRow, string[]>(
        creationLineageSql(false, projectId !== undefined) +
          `, ranked AS (
      SELECT t.*,ROW_NUMBER() OVER(PARTITION BY projectId,historyKey ORDER BY ${creationHeadOrder}) AS historyRank
      FROM identified t WHERE NOT EXISTS(SELECT 1 FROM creation_history_hidden h WHERE h.id=t.id AND h.owner=t.owner)
    ) SELECT * FROM (
      SELECT original.*,ranked.creationRootId,ranked.creationCreatedAt,ranked.creationRounds FROM ranked
      JOIN creation_tasks original ON original.id=ranked.id AND original.owner=ranked.owner WHERE historyRank=1
    ) heads ORDER BY ${projectId === undefined ? creationHeadOrder : "createdAt DESC,id DESC"} LIMIT ${projectId === undefined ? 50 : 20}`,
      )
      .all(...(projectId === undefined ? [owner] : [owner, projectId]))
      .map(creationHistoryTask);
  }
  rounds(owner: string, id: string, cursor?: string) {
    const task = this.tasks.get(owner, id),
      before = creationRoundCursor(cursor);
    const rows = this.db
      .query<CreationLineageRow, (string | number)[]>(
        creationLineageSql(false, true) +
          `, conversation AS (
      SELECT t.*,FIRST_VALUE(id) OVER(ORDER BY ${creationHeadOrder}) AS latestTaskId FROM identified t
      WHERE historyKey=(SELECT historyKey FROM identified WHERE id=?)
    ) SELECT * FROM conversation` +
          (before ? " WHERE (createdAt<? OR (createdAt=? AND id<?))" : "") +
          " ORDER BY createdAt DESC,id DESC LIMIT 11",
      )
      .all(owner, task.spec.projectId, id, ...(before ? [before.at, before.at, before.id] : []));
    return creationRoundPage(rows);
  }
  nextOutput(now: number) {
    creationInteger(now);
    const row = this.db
      .query<CreationTaskRow, [number]>(
        `SELECT * FROM creation_tasks WHERE state='committing' AND artifact IS NULL
      AND (failure IS NULL OR (failure='writeUnavailable' AND updatedAt<=?)) ORDER BY updatedAt,id LIMIT 1`,
      )
      .get(now - 5000);
    return row ? creationTask(row) : null;
  }
}
