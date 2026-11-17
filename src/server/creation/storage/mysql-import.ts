import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import { openSync, closeSync, unlinkSync } from "node:fs";
import { migrateSQLiteModule, type MigrationProgress, type MigrationTable } from "../../database/data-migration.js";
import { creationMySQLModels } from "../../database/modules/creation.js";
import { creationLedgerNamespace } from "./mysql.js";

const tables = creationMySQLModels.filter((m) => m.name !== "panda_force_creation_ledgers");
export const creationSQLiteMappings: readonly MigrationTable[] = [
  {
    source: "creation_ledgers",
    target: "panda_force_creation_ledgers",
    columns: ["namespace"],
    sourceKeys: ["namespace"],
    targetKeys: ["namespace"],
    project: (r) => [r.namespace!],
  },
  ...tables.map((model) => {
    const columns = model.columns.map((c) => c.name),
      keys = model.indexes.find((i) => i.name === "PRIMARY")!.columns;
    return {
      source: model.name.replace("panda_force_", ""),
      target: model.name,
      columns,
      sourceKeys: keys,
      targetKeys: keys,
      numericColumns: model.columns.filter((c) => c.type === "bigint").map((c) => c.name),
      project: (r: Record<string, any>) =>
        columns.map((c) => (c === "pendingTaskId" ? (r.state === "pending" ? r.taskId : null) : r[c])),
    };
  }),
];
/** Inputs must be frozen snapshots captured after fencing all application and personal ledger writers. */
export function consolidateCreationSnapshots(
  destination: string,
  ledgers: readonly { namespace: string; snapshotPath: string }[],
) {
  const namespaces = ledgers.map((l) => creationLedgerNamespace(l.namespace));
  if (new Set(namespaces).size !== namespaces.length) throw Error("duplicateCreationMigrationNamespace");
  closeSync(openSync(destination, "wx", 0o600));
  const target = new Database(destination, { strict: true });
  try {
    target.exec("PRAGMA journal_mode=DELETE");
    target.transaction(() => {
      target.exec("CREATE TABLE creation_ledgers(namespace TEXT PRIMARY KEY)");
      for (const model of tables) {
        const columns = model.columns.filter((c) => c.name !== "pendingTaskId");
        target.exec(
          `CREATE TABLE ${model.name.replace("panda_force_", "")}(${columns.map((c) => `"${c.name}" ${c.type === "bigint" ? "INTEGER" : "TEXT"}${c.nullable ? "" : " NOT NULL"}`).join(",")},PRIMARY KEY(namespace,id))`,
        );
      }
      for (const ledger of ledgers) {
        const source = new Database(ledger.snapshotPath, { readonly: true, strict: true });
        try {
          source.transaction(() => {
            const version = source.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
            if (version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6)
              throw Error("unsupportedCreationMigrationSchema");
            target.query("INSERT INTO creation_ledgers VALUES(?)").run(ledger.namespace);
            for (const model of tables) {
              if (version === 2 && model.name === "panda_force_creation_progress") continue;
              if (version < 4 && model.name === "panda_force_creation_messages") continue;
              if (
                version < 6 &&
                ["panda_force_creation_history_hidden", "panda_force_creation_history_actions"].includes(model.name)
              )
                continue;
              if (version < 5 && model.name === "panda_force_creation_goals") continue;
              const columns = model.columns
                  .filter((c) => !["namespace", "pendingTaskId"].includes(c.name))
                  .map((c) => c.name),
                table = model.name.replace("panda_force_", ""),
                insert = target.query(
                  `INSERT INTO ${table}(namespace,${columns.map((c) => '"' + c + '"').join(",")}) VALUES(${["?", ...columns.map(() => "?")].join(",")})`,
                );
              for (const row of source
                .query<Record<string, any>, []>(
                  `SELECT ${columns.map((c) => '"' + c + '"').join(",")} FROM ${table} ORDER BY rowid`,
                )
                .iterate())
                insert.run(ledger.namespace, ...columns.map((c) => row[c]));
            }
          })();
        } finally {
          source.close();
        }
      }
    })();
  } catch (error) {
    target.close();
    unlinkSync(destination);
    throw error;
  }
  target.close();
  return { snapshotPath: destination, namespaces };
}
export function importCreationSQLite(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({ ...options, module: "creation", converterVersion: 5, tables: creationSQLiteMappings });
}
