import type { Database } from "bun:sqlite";
import type { CreationGoalStore, CreationGoalEvent, CreationGoalCommand } from "../goals/contracts.js";
import type { CreationTaskRepository } from "./repository.js";
import type { CreationQueue } from "./queue.js";
import {
  creationGoalCommand,
  goalActionSignature,
  creationGoalEvent,
  creationGoalResumeId,
} from "../goals/contracts.js";
import { CreationError, type CreationExecution } from "../contracts.js";
import { creationInteger } from "../validation.js";
import { readCreationTask } from "./records.js";

/** Goal metadata and pause/retry actions share the ledger transaction; document bytes remain untouched. */
export class SQLiteCreationGoals implements CreationGoalStore {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<CreationTaskRepository, "cancel" | "get" | "assertExecution">,
    private readonly queue: Pick<CreationQueue, "retry">,
  ) {}
  read(owner: string, taskId: string): CreationGoalEvent | null {
    readCreationTask(this.db, owner, taskId);
    const row = this.db
      .query<{ event: string }, [string, string]>("SELECT event FROM creation_goals WHERE owner=? AND id=?")
      .get(owner, taskId);
    if (!row) return null;
    return creationGoalEvent(JSON.parse(row.event));
  }
  check(owner: string, taskId: string, input: CreationGoalCommand) {
    const command = creationGoalCommand(input),
      action = this.db
        .query<{ owner: string; request: string }, [string]>("SELECT owner,request FROM creation_actions WHERE id=?")
        .get(command.id);
    if (!action) return false;
    if (action.owner !== owner) throw new CreationError("notFound");
    if (action.request !== goalActionSignature(taskId, command)) throw new CreationError("conflict");
    return true;
  }
  command(
    owner: string,
    taskId: string,
    input: CreationGoalCommand,
    now: number,
    execution?: CreationExecution,
  ): CreationGoalEvent {
    const command = creationGoalCommand(input),
      request = goalActionSignature(taskId, command);
    creationInteger(now);
    return this.db
      .transaction(() => {
        if (execution) {
          if (execution.owner !== owner || execution.taskId !== taskId) throw new CreationError("leaseLost");
          this.tasks.assertExecution(execution, now);
        }
        let task = this.tasks.get(owner, taskId);
        const action = this.db
            .query<{ owner: string; request: string }, [string]>(
              "SELECT owner,request FROM creation_actions WHERE id=?",
            )
            .get(command.id),
          prior = this.read(owner, taskId);
        if (action) {
          if (action.owner !== owner) throw new CreationError("notFound");
          if (action.request !== request || !prior) throw new CreationError("conflict");
          return prior;
        }
        if (command.action === "create" && prior?.goal) throw new CreationError("conflict");
        if (command.action !== "set" && command.action !== "create" && command.action !== "clear" && !prior?.goal)
          throw new CreationError("conflict");
        if (["set", "create"].includes(command.action) && task.outputDigest && task.spec.id !== command.id)
          throw new CreationError("conflict");
        if (command.action === "pause") {
          if (task.outputDigest || !["queued", "running", "failed", "cancelled"].includes(task.state))
            throw new CreationError("conflict");
          task = this.tasks.cancel(owner, taskId, now);
        } else if (command.action === "resume") {
          if (task.artifact) throw new CreationError("conflict");
          if (["failed", "cancelled"].includes(task.state) || (task.state === "committing" && task.failure))
            task = this.queue.retry(owner, taskId, creationGoalResumeId(command.id), now);
        }
        const at = Math.max(now, (prior?.at || 0) + 1),
          goal =
            command.action === "clear"
              ? null
              : {
                  id: prior?.goal?.id || command.id,
                  objective: ["set", "create"].includes(command.action) ? command.objective! : prior!.goal!.objective,
                  status: (command.action === "pause" ||
                  (["set", "create"].includes(command.action) &&
                    (prior?.goal?.status === "paused" || task.state === "cancelled"))
                    ? "paused"
                    : "active") as "paused" | "active",
                  updatedAt: at,
                };
        const event: CreationGoalEvent = { at, goal };
        this.db
          .query(
            "INSERT INTO creation_goals(id,owner,event) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET event=excluded.event",
          )
          .run(taskId, owner, JSON.stringify(event));
        this.db
          .query("INSERT INTO creation_actions(id,owner,taskId,request,createdAt) VALUES(?,?,?,?,?)")
          .run(command.id, owner, taskId, request, now);
        return event;
      })
      .immediate();
  }
}
