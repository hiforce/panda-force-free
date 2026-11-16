import ddl from "./bots-mysql-v1.json";
import type { DatabaseModule, SchemaIssue } from "../registry.js";
import { inspectTable } from "../schema-inspection.js";

/** Version one is immutable. New tables, fields and indexes append a new migration. */
export const mysqlBotModule: DatabaseModule = {
  id: "bots",
  dependencies: [],
  backends: { sqlite: { readWrite: true, importFrom: [] }, mysql: { readWrite: true, importFrom: ["sqlite"] } },
  migrations: {
    mysql: [
      {
        version: 1,
        steps: ddl.map((entry) => ({ id: entry.table, sql: entry.sql, satisfied: (c) => c.table(entry.table) })),
      },
      {
        version: 2,
        steps: [
          {
            id: "retention-index",
            sql: "CREATE INDEX bot_tasks_retention ON panda_force_bot_tasks(status,updatedAt,seq)",
            satisfied: (c) => c.index("panda_force_bot_tasks", "bot_tasks_retention"),
          },
          {
            id: "manual-queue-index",
            sql: "CREATE INDEX bot_tasks_manual_queue ON panda_force_bot_tasks(botId,status,decision,seq)",
            satisfied: (c) => c.index("panda_force_bot_tasks", "bot_tasks_manual_queue"),
          },
        ],
      },
      {
        version: 3,
        steps: [
          {
            id: "task-action-identifiers",
            sql: "ALTER TABLE panda_force_bot_tasks ADD COLUMN actionId VARCHAR(64) NULL",
            satisfied: (c) => c.column("panda_force_bot_tasks", "actionId"),
          },
          {
            id: "task-action-queue-index",
            sql: "CREATE INDEX bot_tasks_action_queue ON panda_force_bot_tasks(botId,status,actionId,seq)",
            satisfied: (c) => c.index("panda_force_bot_tasks", "bot_tasks_action_queue"),
          },
        ],
      },
    ],
  },
  async inspect(connection) {
    const issues: SchemaIssue[] = [];
    for (const table of ddl) issues.push(...(await inspectTable(connection, "bots", table.definition)));
    const tasks = await connection.describe("panda_force_bot_tasks");
    if (tasks)
      issues.push(
        ...(await inspectTable(connection, "bots", {
          name: tasks.name,
          columns: [{ name: "actionId", type: "varchar(64)", nullable: true }],
          indexes: [
            { name: "bot_tasks_retention", unique: false, columns: ["status", "updatedAt", "seq"] },
            { name: "bot_tasks_manual_queue", unique: false, columns: ["botId", "status", "decision", "seq"] },
            { name: "bot_tasks_action_queue", unique: false, columns: ["botId", "status", "actionId", "seq"] },
          ],
        })),
      );
    return issues;
  },
};
