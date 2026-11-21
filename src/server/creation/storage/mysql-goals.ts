import { CreationError } from "../contracts.js";
import type { CreationGoalEvent, CreationGoalStore } from "../goals/contracts.js";
import {
  creationGoalCommand,
  creationGoalEvent,
  creationGoalResumeId,
  goalActionSignature,
} from "../goals/contracts.js";
import { creationInteger } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import type { MySQLCreationLeases } from "./mysql-leases.js";
import type { MySQLCreationTasks } from "./mysql-tasks.js";

/** Goals operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationGoals {
  constructor(
    private readonly context: MySQLCreationContext,
    private readonly tasks: MySQLCreationTasks,
    private readonly leases: MySQLCreationLeases,
  ) {}
  readonly goals: CreationGoalStore = {
    check: async (owner, taskId, input) => {
      const command = creationGoalCommand(input),
        rows = await this.context
          .sql`SELECT owner,request FROM panda_force_creation_actions WHERE namespace=${this.context.namespace} AND id=${command.id}`;
      if (!rows.length) return false;
      if (rows[0].owner !== owner) throw new CreationError("notFound");
      if (rows[0].request !== goalActionSignature(taskId, command)) throw new CreationError("conflict");
      return true;
    },
    read: async (owner, taskId) => {
      await this.tasks.row(owner, taskId);
      const rows = await this.context
        .sql`SELECT event FROM panda_force_creation_goals WHERE namespace=${this.context.namespace} AND owner=${owner} AND id=${taskId}`;
      if (!rows.length) return null;
      return creationGoalEvent(JSON.parse(String(rows[0].event)));
    },
    command: async (owner, taskId, input, now, execution) => {
      const command = creationGoalCommand(input),
        request = goalActionSignature(taskId, command);
      creationInteger(now);
      return this.context.transaction(async () => {
        if (execution) {
          if (execution.owner !== owner || execution.taskId !== taskId) throw new CreationError("leaseLost");
          await this.leases.assertExecution(execution, now);
        }
        let task = await this.tasks.get(owner, taskId);
        const actions = await this.context
            .sql`SELECT owner,request FROM panda_force_creation_actions WHERE namespace=${this.context.namespace} AND id=${command.id}`,
          prior = await this.goals.read(owner, taskId);
        if (actions.length) {
          if (actions[0].owner !== owner) throw new CreationError("notFound");
          if (actions[0].request !== request || !prior) throw new CreationError("conflict");
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
          task = await this.tasks.cancel(owner, taskId, now);
        } else if (command.action === "resume") {
          if (task.artifact) throw new CreationError("conflict");
          if (["failed", "cancelled"].includes(task.state) || (task.state === "committing" && task.failure))
            task = await this.tasks.retry(owner, taskId, creationGoalResumeId(command.id), now);
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
                    : "active") as "active" | "paused",
                  updatedAt: at,
                };
        const event: CreationGoalEvent = { at, goal };
        await this.context
          .sql`INSERT INTO panda_force_creation_goals(namespace,id,owner,event) VALUES(${this.context.namespace},${taskId},${owner},${JSON.stringify(event)}) ON DUPLICATE KEY UPDATE event=VALUES(event)`;
        await this.context
          .sql`INSERT INTO panda_force_creation_actions(namespace,id,owner,taskId,request,createdAt) VALUES(${this.context.namespace},${command.id},${owner},${taskId},${request},${now})`;
        return event;
      });
    },
  };
}
