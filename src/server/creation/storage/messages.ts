import type { Database } from "bun:sqlite";
import type { CreationLease } from "../contracts.js";
import type { CreationMessageRecord, CreationMessageStore } from "../messages/contracts.js";
import { CreationError } from "../contracts.js";
import { readCreationTask } from "./records.js";
import { creationUuid } from "../validation.js";

/** Message acceptance and output admission use the same short ledger transaction. */
export class SQLiteCreationMessages implements CreationMessageStore {
  constructor(private readonly db: Database) {}
  find(owner: string, id: string) {
    const row = this.db
      .query<CreationMessageRecord, [string]>("SELECT * FROM creation_messages WHERE id=?")
      .get(creationUuid(id));
    if (row && row.owner !== owner) throw new CreationError("notFound");
    return row;
  }
  accept(value: CreationMessageRecord) {
    return this.db
      .transaction(() => {
        const prior = this.find(value.owner, value.id);
        if (prior) {
          if (prior.requestDigest !== value.requestDigest || prior.taskId !== value.taskId)
            throw new CreationError("conflict");
          return prior;
        }
        const task = readCreationTask(this.db, value.owner, value.taskId);
        if (
          !["queued", "running"].includes(task.state) ||
          task.cancelRequested ||
          task.outputDigest ||
          value.generation !== task.generation
        )
          throw new CreationError("conflict");
        const count = this.db
          .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM creation_messages WHERE taskId=?")
          .get(value.taskId)!.n;
        if (count >= 32) throw new CreationError("unavailable");
        const previous = this.db
          .query<{ at: number | null }, [string]>("SELECT MAX(createdAt) at FROM creation_messages WHERE taskId=?")
          .get(value.taskId);
        const acceptedAt = Math.max(value.createdAt, (previous?.at ?? -1) + 1);
        this.db
          .query(
            "INSERT INTO creation_messages(id,owner,taskId,generation,requestDigest,payloadDigest,state,dispatchGeneration,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'received',NULL,?,?)",
          )
          .run(
            value.id,
            value.owner,
            value.taskId,
            value.generation,
            value.requestDigest,
            value.payloadDigest,
            acceptedAt,
            Math.max(acceptedAt, value.updatedAt),
          );
        return this.find(value.owner, value.id)!;
      })
      .immediate();
  }
  list(owner: string, taskId: string) {
    readCreationTask(this.db, owner, taskId);
    return this.db
      .query<CreationMessageRecord, [string]>("SELECT * FROM creation_messages WHERE taskId=? ORDER BY createdAt,id")
      .all(taskId);
  }
  claim(lease: CreationLease, now: number) {
    return this.db
      .transaction(() => {
        const task = readCreationTask(this.db, lease.owner, lease.taskId);
        if (
          task.state !== "running" ||
          task.token !== lease.token ||
          task.generation !== lease.generation ||
          task.cancelRequested ||
          (task.leaseUntil || 0) <= now
        )
          return null;
        this.db
          .query(
            "UPDATE creation_messages SET state='uncertain',updatedAt=? WHERE taskId=? AND state='dispatching' AND dispatchGeneration<>?",
          )
          .run(now, lease.taskId, lease.generation);
        const row = this.db
          .query<CreationMessageRecord, [string]>(
            "SELECT * FROM creation_messages WHERE taskId=? AND state='received' ORDER BY createdAt,id LIMIT 1",
          )
          .get(lease.taskId);
        if (!row) return null;
        this.db
          .query("UPDATE creation_messages SET state='dispatching',dispatchGeneration=?,updatedAt=? WHERE id=?")
          .run(lease.generation, now, row.id);
        return this.find(lease.owner, row.id);
      })
      .immediate();
  }
  settle(lease: CreationLease, id: string, state: "delivered" | "uncertain", now: number) {
    this.db
      .transaction(() => {
        const task = readCreationTask(this.db, lease.owner, lease.taskId);
        if (task.generation !== lease.generation) return;
        this.db
          .query(
            "UPDATE creation_messages SET state=?,updatedAt=? WHERE id=? AND owner=? AND taskId=? AND dispatchGeneration=? AND state='dispatching'",
          )
          .run(state, now, id, lease.owner, lease.taskId, lease.generation);
      })
      .immediate();
  }
  seen(lease: CreationLease, ids: readonly string[], now: number) {
    this.db
      .transaction(() => {
        const task = readCreationTask(this.db, lease.owner, lease.taskId);
        if (
          task.state !== "running" ||
          task.token !== lease.token ||
          task.generation !== lease.generation ||
          task.cancelRequested ||
          (task.leaseUntil || 0) <= now
        )
          throw new CreationError("leaseLost");
        for (const id of ids)
          this.db
            .query(
              "UPDATE creation_messages SET state='delivered',dispatchGeneration=?,updatedAt=? WHERE id=? AND owner=? AND taskId=? AND state<>'delivered'",
            )
            .run(lease.generation, now, id, lease.owner, lease.taskId);
      })
      .immediate();
  }
}
