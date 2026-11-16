import { SQL } from "bun";
import type { ApplicationDatabaseConfig } from "./config.js";
import { readPrivateDatabaseFile } from "./config.js";
import { createApplicationDatabaseRegistry } from "./application-registry.js";
import type { DatabaseRegistry } from "./registry.js";
import { MySQLSchemaConnection } from "./mysql-schema.js";
import {
  retryMySQLConnection,
  mysqlStartupRetry,
  mysqlConnectionFailure,
  type ConnectionRetryPolicy,
} from "./connection-policy.js";

/** All owned domains must be implemented before a caller can open an application-wide MySQL backend. */
export async function openApplicationDatabase(
  config: ApplicationDatabaseConfig,
  registry: DatabaseRegistry = createApplicationDatabaseRegistry(),
) {
  if (config.driver === "sqlite") return { driver: "sqlite" as const, sql: null, close: async () => {} };
  registry.assertCutoverReady("mysql", "sqlite");
  const sql = await connectMySQL(config, mysqlStartupRetry);
  try {
    await registry.upgrade(new MySQLSchemaConnection(sql));
    return { driver: "mysql" as const, sql, close: () => sql.close() };
  } catch (error) {
    await sql.close();
    throw error;
  }
}

/** Connection primitive for explicitly scoped backends; callers own their registry and activation checks. */
export async function connectMySQL(
  config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>,
  retry: ConnectionRetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
) {
  const { tls: transport, ...settings } = config.mysql;
  const tls =
    transport.mode === "disabled"
      ? false
      : {
          rejectUnauthorized: true,
          ...(transport.caFile
            ? { ca: (await readPrivateDatabaseFile(transport.caFile, 65536, false)).toString("utf8") }
            : {}),
        };
  return retryMySQLConnection(
    async () => {
      const sql = new SQL({ adapter: "mysql", ...settings, maxLifetime: settings.maxLifetime ?? 1800, tls });
      try {
        const server = (await sql`SELECT VERSION() version,@@sql_mode mode`)[0];
        if (!/^8\./.test(server.version) || !/(?:STRICT_TRANS_TABLES|STRICT_ALL_TABLES)/.test(server.mode))
          throw Error("unsupportedDatabaseServer");
        return sql;
      } catch (error) {
        await sql.close().catch(() => {});
        const failure = mysqlConnectionFailure(error);
        if (failure === "blocked" || failure === "handshake")
          throw new Error(
            failure === "blocked"
              ? "mysqlHostBlocked: inspect host_cache and unblock through a database administrator"
              : "mysqlHandshakeRejected: verify the endpoint and inspect server host_cache for a blocked source",
            { cause: error },
          );
        throw error;
      }
    },
    retry,
    {
      retry: (attempt, delay) =>
        console.warn(`[PandaForce] MySQL connection unavailable; attempt ${attempt}/${retry.attempts} in ${delay}ms`),
    },
  );
}
