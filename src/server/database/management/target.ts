import type { DatabaseIssue, DatabaseTargetSummary } from "../../../shared/database/contracts.js";
import type { ApplicationDatabaseConfig } from "../config.js";
import type { DatabaseRegistry } from "../registry.js";
import { connectMySQL } from "../provider.js";
import { MySQLSchemaConnection } from "../mysql-schema.js";
import { databaseTableOwnership } from "../table-ownership.js";
import type { DatabaseManagementState } from "./state.js";
import type { SQL } from "bun";
import { databaseTargetHash } from "../migration/activation.js";

/** Planning uses read-only inventory queries. Schema creation belongs to the fenced migration stage. */
export async function inspectDatabaseTarget(options: {
  config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>;
  registry: DatabaseRegistry;
  state: DatabaseManagementState;
  bot?: DatabaseTargetSummary;
  sql?: SQL;
  allowedOperationId?: string;
}): Promise<DatabaseIssue[]> {
  const { config, registry, state } = options,
    sql = options.sql ?? (await connectMySQL(config));
  try {
    const installation = await state.installation(false),
      ownership = databaseTableOwnership(registry);
    const present = new Set<string>(
      (await sql`SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`).map(
        (r: { name: string }) => r.name,
      ),
    );
    let botOwned = false;
    if (present.has("panda_force_bot_control")) {
      const value = (await sql`SELECT value FROM panda_force_bot_control WHERE name='installation'`)[0]?.value;
      if (value) {
        let owner;
        try {
          owner = JSON.parse(value);
        } catch {
          return [{ code: "migrationTargetAlreadyOwned" }];
        }
        if (owner?.id !== installation.id) return [{ code: "migrationTargetAlreadyOwned" }];
        const bot = options.bot;
        botOwned =
          bot?.driver === "mysql" &&
          bot.hostname === config.mysql.hostname &&
          bot.port === config.mysql.port &&
          bot.database === config.mysql.database;
        if (!botOwned) return [{ code: "botDatabaseTargetMismatch" }];
      }
    }
    let sameOperation = false;
    if (present.has("panda_force_database_installation")) {
      const control = (
        await sql`SELECT installationId,operationId,targetHash,state FROM panda_force_database_installation WHERE id=1`
      )[0];
      if (control) {
        sameOperation =
          !!options.allowedOperationId &&
          control.installationId === installation.id &&
          control.operationId === options.allowedOperationId &&
          control.targetHash === databaseTargetHash(config) &&
          ["staging", "active"].includes(control.state);
        if (!sameOperation) return [{ code: "migrationTargetAlreadyOwned" }];
      }
    }
    for (const [table, module] of ownership.owners) {
      if (
        sameOperation ||
        !present.has(table) ||
        module === "data-migrations" ||
        /(?:_mutex|_guard)$/.test(table) ||
        (module === "bots" && botOwned)
      )
        continue;
      if ((await sql.unsafe(`SELECT 1 present FROM \`${table}\` LIMIT 1`)).length)
        return [{ code: "migrationTargetAlreadyOwned", module }];
    }
    const issues = await registry.inspect(new MySQLSchemaConnection(sql));
    return issues
      .filter((i) =>
        ["incompatibleColumn", "incompatibleIndex", "changedMigration", "unsupportedVersion"].includes(i.code),
      )
      .map((i) => ({ code: "databaseSchemaDrift", module: i.module, object: i.object }));
  } finally {
    if (!options.sql) await sql.close();
  }
}
