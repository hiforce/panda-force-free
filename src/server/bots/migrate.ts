import { migrateSQLiteModule, type MigrationTable } from "../database/data-migration.js";
import { botTaskState } from "../../shared/bots/task-state.js";
import type { BotTask } from "../../shared/bots/contracts.js";
import { taskSummary } from "./task-title.js";

const direct = (source: string, columns: string[], keys: string[], optional = false): MigrationTable => ({
  source,
  target: "panda_force_" + source,
  columns,
  sourceKeys: keys,
  targetKeys: keys,
  optional,
  project: (row) => columns.map((c) => row[c] ?? null),
});
const tasks: MigrationTable = {
  source: "bot_tasks",
  target: "panda_force_bot_tasks",
  columns: [
    "seq",
    "id",
    "owner",
    "botId",
    "idem",
    "fingerprint",
    "status",
    "state",
    "lease",
    "leaseUntil",
    "externalTaskId",
    "title",
    "summary",
    "decision",
    "actionId",
    "failure",
    "createdAt",
    "updatedAt",
    "data",
  ],
  sourceKeys: ["rowid"],
  targetKeys: ["seq"],
  numericColumns: ["seq", "leaseUntil", "createdAt", "updatedAt"],
  project(row) {
    const task = JSON.parse(String(row.data)) as BotTask,
      deleted = row.status === "deleted",
      actionId = !deleted && task.input.actions?.some((action) => action.id === task.decision) ? task.decision : null;
    return [
      row.__cursor!,
      row.id!,
      row.owner!,
      row.botId!,
      row.idem!,
      row.fingerprint!,
      row.status!,
      deleted ? "canceled" : botTaskState(task),
      row.lease ?? null,
      row.leaseUntil ?? null,
      deleted ? "" : task.externalTaskId,
      task.title ?? null,
      deleted ? "" : taskSummary({ ...task, summary: task.input.input.text }).summary,
      actionId ? null : (task.decision ?? null),
      actionId,
      task.failure ?? null,
      task.createdAt ?? 0,
      task.updatedAt ?? 0,
      row.data!,
    ];
  },
};
export const botMigrationTables: readonly MigrationTable[] = [
  direct("bots", ["id", "owner", "code", "data"], ["id"]),
  direct("bot_keys", ["id", "owner", "digest", "data"], ["id"]),
  tasks,
  {
    source: "bot_events",
    target: "panda_force_bot_events",
    columns: ["seq", "taskId", "createdAt", "kind", "detail"],
    sourceKeys: ["rowid"],
    targetKeys: ["seq"],
    numericColumns: ["seq", "createdAt"],
    project: (r) => [r.__cursor!, r.taskId!, r.createdAt!, r.kind!, r.detail!],
  },
  direct("bot_sessions", ["id"], ["id"]),
  direct("bot_avatars", ["owner", "id", "bytes"], ["owner", "id"], true),
  direct("bot_settings", ["owner", "retentionDays"], ["owner"], true),
];
export const migrateBotSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) =>
  migrateSQLiteModule({
    ...options,
    limits: options.limits ?? { maxRecordBytes: 4 * 1024 * 1024, maxBatchBytes: 8 * 1024 * 1024 },
    converterVersion: 2,
    module: "bots",
    tables: botMigrationTables,
  });
