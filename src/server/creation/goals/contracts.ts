import type { CreationResult } from "../ports.js";
import type { CreationExecution, CreationTask } from "../contracts.js";
import type { CreationGoal, CreationGoalCommand } from "../../../shared/creation/contracts.js";
export type { CreationGoalCommand } from "../../../shared/creation/contracts.js";
import { CreationError } from "../contracts.js";
import {
  creationRecord,
  creationGoalObjective,
  creationUuid,
  creationText,
  creationId,
  creationGoal,
  creationInteger,
} from "../validation.js";
import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { creationUuidFromDigest } from "../validation.js";
const signature = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export function creationGoalResumeId(actionId: string) {
  return creationUuidFromDigest(signature({ purpose: "creation-goal-resume", actionId }));
}

export interface CreationGoalEvent {
  at: number;
  goal: CreationGoal | null;
}
export function creationGoalEvent(value: unknown): CreationGoalEvent {
  const row = creationRecord(value, ["at", "goal"]),
    at = creationInteger(row.at),
    goal = row.goal === null ? null : creationGoal(row.goal);
  if (goal && goal.updatedAt !== at) throw new CreationError("invalidInput");
  return { at, goal };
}
export interface CreationGoalStore {
  read(owner: string, taskId: string): CreationResult<CreationGoalEvent | null>;
  check(owner: string, taskId: string, command: CreationGoalCommand): CreationResult<boolean>;
  command(
    owner: string,
    taskId: string,
    command: CreationGoalCommand,
    now: number,
    execution?: CreationExecution,
  ): CreationResult<CreationGoalEvent>;
}
export function creationGoalCommand(value: unknown): CreationGoalCommand {
  const row = creationRecord(value, ["id", "action", "objective", "runtimeId", "model", "effort"]);
  if (!["set", "create", "pause", "resume", "clear"].includes(String(row.action)))
    throw new CreationError("invalidInput");
  const action = row.action as CreationGoalCommand["action"];
  if (
    !["set", "create"].includes(action) &&
    [row.objective, row.runtimeId, row.model, row.effort].some((value) => value !== undefined)
  )
    throw new CreationError("invalidInput");
  return {
    id: creationUuid(row.id),
    action,
    ...(row.runtimeId === undefined ? {} : { runtimeId: creationId(row.runtimeId) }),
    ...(row.model === undefined ? {} : { model: creationText(row.model, 128) }),
    ...(row.effort === undefined ? {} : { effort: creationText(row.effort, 64) }),
    ...(["set", "create"].includes(action) ? { objective: creationGoalObjective(row.objective) } : {}),
  };
}
export function goalActionSignature(taskId: string, command: CreationGoalCommand) {
  return signature({ namespace: "creation-goal", taskId, ...command });
}
/** A goal covers the task's primary document; outcome follows its real saved receipt and retry state. */
export function creationGoalView(
  event: CreationGoalEvent | null,
  task: Pick<CreationTask, "state" | "artifact">,
): CreationGoal | null {
  if (!event?.goal) return null;
  const status =
    event.goal.status === "paused" || task.state === "cancelled"
      ? "paused"
      : task.state === "failed"
        ? "blocked"
        : task.state === "succeeded" && task.artifact
          ? "completed"
          : "active";
  return { ...event.goal, status };
}
