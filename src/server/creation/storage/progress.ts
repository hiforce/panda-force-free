import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { CreationLease } from "../contracts.js";
import type { CreationProgress } from "../../../shared/creation/contracts.js";
import type { CreationProgressStore } from "../ports.js";
import { creationProgress } from "../validation.js";
import { readCreationTask } from "./records.js";

export class SQLiteCreationProgress implements CreationProgressStore {
  constructor(private readonly db: Database) {}
  record(lease: CreationLease, value: CreationProgress) {
    const event = creationProgress(value);
    this.db
      .transaction(() => {
        const task = readCreationTask(this.db, lease.owner, lease.taskId);
        if (task.generation !== lease.generation || event.generation !== lease.generation) return;
        if (event.id) {
          const current = this.db
            .query("SELECT id FROM creation_progress WHERE id=? AND taskId=? AND generation=?")
            .get(event.id, lease.taskId, lease.generation);
          if (current) {
            this.db.query("UPDATE creation_progress SET event=? WHERE id=?").run(JSON.stringify(event), event.id);
            return;
          }
        }
        const count = this.db
          .query<{ n: number }, [string, number]>(
            "SELECT COUNT(*) n FROM creation_progress WHERE taskId=? AND generation=?",
          )
          .get(lease.taskId, lease.generation)!.n;
        if (count >= 64) return;
        this.db
          .query("INSERT INTO creation_progress(id,taskId,generation,createdAt,ordinal,event) VALUES(?,?,?,?,?,?)")
          .run(event.id || randomUUID(), lease.taskId, lease.generation, event.at, count, JSON.stringify(event));
      })
      .immediate();
  }
  list(owner: string, id: string, conversation = true) {
    readCreationTask(this.db, owner, id);
    return this.db
      .query<{ event: string }, [string, number]>(
        "SELECT event FROM (SELECT event,generation,ordinal FROM creation_progress WHERE taskId=? AND (?=1 OR json_extract(event,'$.stage')<>'message') ORDER BY generation DESC,ordinal DESC LIMIT 192) ORDER BY generation,ordinal",
      )
      .all(id, conversation ? 1 : 0)
      .map((row) => creationProgress(JSON.parse(row.event)));
  }
}
