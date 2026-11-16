import { botTaskData } from "./task-record.js";
import type { Database } from "bun:sqlite";
import type { BotTask } from "../../shared/bots/contracts.js";
import { BotError } from "../../shared/bots/contracts.js";
import { botTaskState, botTaskView } from "../../shared/bots/task-state.js";
import { botHasCallbackDecision } from "../../shared/bots/actions.js";

/** Cancel and pause fence the current lease before an engine interruption can return late output. */
export function changeBotTaskLifecycle(
  store: {
    db: Database;
    task(owner: string, id: string): BotTask;
    event(id: string, kind: string, detail: string): void;
  },
  owner: string,
  id: string,
  action: "cancel" | "suspend" | "resume",
) {
  return store.db
    .transaction(() => {
      const current = store.task(owner, id);
      if (
        (action === "cancel" && current.status === "canceled") ||
        (action === "suspend" && current.status === "suspended") ||
        (action === "resume" && ["queued", "running"].includes(current.status))
      )
        return botTaskView(current);
      const next = transitionBotTask(current, action);
      store.db
        .query("UPDATE bot_tasks SET status=?,data=?,lease=NULL,leaseUntil=NULL WHERE owner=? AND id=?")
        .run(next.status, botTaskData(next), owner, id);
      store.event(id, action, "Task execution " + action + " requested by its owner");
      return next;
    })
    .immediate();
}

export function transitionBotTask(
  task: import("../../shared/bots/contracts.js").BotTask,
  action: "cancel" | "suspend" | "resume",
) {
  const state = botTaskState(task);
  if (action === "cancel" && state === "canceled") return botTaskView(task);
  if (action === "suspend" && task.status === "suspended") return botTaskView(task);
  if (action === "resume" && ["queued", "running"].includes(task.status)) return botTaskView(task);
  if (["finished", "canceled"].includes(state)) throw new BotError("invalidState", 409);
  if (task.status === "callback_unknown" || (task.status === "running" && botHasCallbackDecision(task)))
    throw new BotError("callbackInFlight", 409);
  if (action === "resume" && task.status !== "suspended" && !(state === "error" && task.failure === "execution"))
    throw new BotError("invalidState", 409);
  if (action === "suspend" && !["queued", "running"].includes(task.status)) throw new BotError("invalidState", 409);
  task.status = action === "cancel" ? "canceled" : action === "suspend" ? "suspended" : "queued";
  if (action === "resume") {
    delete task.failure;
    if (!task.decision) task.reason = null;
    task.runId = null;
  }
  task.updatedAt = Date.now();
  return botTaskView(task);
}
