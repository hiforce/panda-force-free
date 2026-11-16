import { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../shared/records.js";
import {
  databaseConfiguration,
  databaseConfigurationSummary,
  readPrivateDatabaseFile,
  type ApplicationDatabaseConfig,
} from "../database/config.js";
import { connectMySQL } from "../database/provider.js";
import { mysqlStartupRetry } from "../database/connection-policy.js";
import { DatabaseRegistry } from "../database/registry.js";
import { MySQLSchemaConnection } from "../database/mysql-schema.js";
import { mysqlBotModule } from "../database/modules/bots.js";
import { mysqlDataMigrationModule } from "../database/modules/migrations.js";
import { BotStore } from "./store.js";
import { MySQLBotStore } from "./mysql-store.js";
import { botMigrationTables, migrateBotSnapshot } from "./migrate.js";

type MySQLConfig = Extract<ApplicationDatabaseConfig, { driver: "mysql" }>;
interface Installation {
  schema: 1;
  id: string;
  target: string;
  migrationId: string;
}
const absent = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const targetHash = (config: MySQLConfig) =>
  createHash("sha256")
    .update(JSON.stringify([config.mysql.hostname, config.mysql.port, config.mysql.database]))
    .digest("hex");
const readRecord = async (path: string) => {
  try {
    return JSON.parse((await readPrivateDatabaseFile(path)).toString("utf8"));
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};
async function writeRecord(path: string, value: unknown) {
  const temporary = path + "." + randomUUID();
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
async function sourceFingerprint(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalidBotDatabaseSource");
  const hash = createHash("sha256"),
    source = new Database(path, { readonly: true, strict: true });
  try {
    source.exec("BEGIN");
    // Read logical rows: opening a WAL database can create empty sidecars without changing business data.
    for (const table of botMigrationTables) {
      hash.update(table.source);
      if (!source.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.source)) {
        hash.update("absent");
        continue;
      }
      for (const row of source.query(`SELECT rowid,* FROM ${table.source} ORDER BY rowid`).iterate())
        hash.update(
          JSON.stringify(row, (_key, value) =>
            value instanceof Uint8Array ? { binary: Buffer.from(value).toString("base64") } : value,
          ),
        );
    }
  } finally {
    source.close();
  }
  return hash.digest("hex");
}
export const createBotDatabaseRegistry = () =>
  new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlBotModule);

/** A Bot-only selector. Other domains keep their existing stores during this explicitly scoped rollout. */
export async function readBotDatabaseConfig(stateRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const file = env.PANDA_FORCE_BOT_DATABASE_CONFIG_FILE ?? join(stateRoot, "config", "bot-database.json");
  try {
    const value = JSON.parse((await readPrivateDatabaseFile(file)).toString("utf8"));
    // Administrator configuration exports may encode a port as decimal text.
    // Normalize that one field before applying all strict bounds and key checks.
    if (
      isRecord(value) &&
      isRecord(value.mysql) &&
      typeof value.mysql.port === "string" &&
      /^\d{1,5}$/.test(value.mysql.port)
    )
      value.mysql.port = Number(value.mysql.port);
    return databaseConfiguration(value);
  } catch (error) {
    if (!env.PANDA_FORCE_BOT_DATABASE_CONFIG_FILE && absent(error)) return { schema: 1, driver: "sqlite" } as const;
    throw new Error("invalidBotDatabaseConfiguration", { cause: error });
  }
}

/** Start only after every old SQLite application process has stopped. Never run concurrently with SQLite writers. */
export async function activateBotDatabase(options: {
  sql: SQL;
  config: MySQLConfig;
  stateRoot: string;
  migrateSQLite: boolean;
}) {
  const { sql, config, stateRoot } = options;
  const root = join(stateRoot, "database-migrations", "bots"),
    identityPath = join(root, "installation.json"),
    receiptPath = join(root, "activation.json"),
    snapshotPath = join(root, "source.sqlite"),
    sourcePath = join(stateRoot, "data", "bot-tasks.sqlite"),
    sourceRecordPath = join(root, "source.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let installation: Installation | null = await readRecord(identityPath);
  const target = targetHash(config);
  if (installation) {
    if (
      installation.schema !== 1 ||
      !/^[a-f0-9-]{36}$/.test(installation.id) ||
      !/^[a-f0-9-]{36}$/.test(installation.migrationId) ||
      installation.target !== target
    )
      throw new Error("botDatabaseInstallationMismatch");
  } else {
    if (!options.migrateSQLite) throw new Error("botDatabaseMigrationRequired");
    installation = { schema: 1, id: randomUUID(), target, migrationId: randomUUID() };
    await writeRecord(identityPath, installation);
  }
  const owner = JSON.stringify(installation);
  // An installation marker is distinct from queue locks and never updated by workers.
  await sql.begin(async (tx) => {
    await tx`INSERT INTO panda_force_bot_control(name,value) VALUES('installation',${owner}) ON DUPLICATE KEY UPDATE name=VALUES(name)`;
    const record = (await tx`SELECT value FROM panda_force_bot_control WHERE name='installation' FOR UPDATE`)[0];
    if (record?.value !== owner) throw new Error("botDatabaseAlreadyOwned");
  });
  const receipt = await readRecord(receiptPath);
  if (receipt) {
    if (
      receipt.schema !== 1 ||
      receipt.id !== installation.id ||
      receipt.target !== target ||
      receipt.migrationId !== installation.migrationId ||
      receipt.state !== "complete"
    )
      throw new Error("botDatabaseActivationMismatch");
    const run = (
      await sql`SELECT state,sourceHash FROM panda_force_data_migration_runs WHERE id=${installation.migrationId} AND module='bots'`
    )[0];
    if (run?.state !== "complete" || run.sourceHash !== receipt.sourceHash)
      throw new Error("botDatabaseActivationMismatch");
    return { driver: "mysql" as const, migrated: false };
  }
  if (!options.migrateSQLite) throw new Error("botDatabaseMigrationRequired");
  let snapshotExists = false;
  try {
    const snapshot = await lstat(snapshotPath);
    snapshotExists = snapshot.isFile() && !snapshot.isSymbolicLink();
    if (!snapshotExists) throw new Error("invalidBotDatabaseSnapshot");
  } catch (error) {
    if (!absent(error)) throw error;
  }
  if (!snapshotExists) {
    try {
      await stat(sourcePath);
    } catch (error) {
      if (!absent(error)) throw error;
      // A fresh installation still uses the same reviewed snapshot/import protocol.
      const empty = new BotStore(sourcePath);
      empty.close();
    }
    const fingerprint = await sourceFingerprint(sourcePath),
      temporary = snapshotPath + "." + randomUUID(),
      source = new Database(sourcePath, { readonly: true, strict: true });
    try {
      source.query("VACUUM INTO ?").run(temporary);
    } finally {
      source.close();
    }
    if ((await sourceFingerprint(sourcePath)) !== fingerprint) throw new Error("botDatabaseSourceChanged");
    await chmod(temporary, 0o600);
    await writeRecord(sourceRecordPath, { fingerprint });
    await rename(temporary, snapshotPath);
  }
  const sourceRecord = await readRecord(sourceRecordPath);
  if (!sourceRecord || sourceRecord.fingerprint !== (await sourceFingerprint(sourcePath)))
    throw new Error("botDatabaseSourceChanged");
  const snapshot = new Database(snapshotPath, { readonly: true, strict: true });
  try {
    if (snapshot.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("invalidBotDatabaseSnapshot");
  } finally {
    snapshot.close();
  }
  const migration = await migrateBotSnapshot({
    sql,
    snapshotPath,
    migrationId: installation.migrationId,
  });
  if (sourceRecord.fingerprint !== (await sourceFingerprint(sourcePath))) throw new Error("botDatabaseSourceChanged");
  await writeRecord(receiptPath, { ...installation, ...migration, completedAt: Date.now() });
  return { driver: "mysql" as const, migrated: true };
}

export async function openBotDatabase(stateRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const config = await readBotDatabaseConfig(stateRoot, env);
  if (config.driver === "sqlite") {
    // Once activated, an absent/changed selector must never revive the stale SQLite queue.
    if (await readRecord(join(stateRoot, "database-migrations", "bots", "installation.json")))
      throw new Error("botDatabaseRollbackRequiresMigration");
    return {
      driver: "sqlite" as const,
      summary: databaseConfigurationSummary(config),
      store: null,
      close: async () => {},
    };
  }
  const sql = await connectMySQL(config, mysqlStartupRetry);
  try {
    await createBotDatabaseRegistry().upgrade(new MySQLSchemaConnection(sql));
    const activation = await activateBotDatabase({
      sql,
      config,
      stateRoot,
      migrateSQLite: env.PANDA_FORCE_BOT_DATABASE_MIGRATE === "sqlite",
    });
    const value = env.PANDA_FORCE_BOT_MAX_PENDING_PER_OWNER,
      maxPendingPerOwner = value === undefined ? 10000 : Number(value);
    if (!Number.isSafeInteger(maxPendingPerOwner) || maxPendingPerOwner < 1000 || maxPendingPerOwner > 1000000)
      throw new Error("invalidBotQueueCapacity");
    const store = await MySQLBotStore.open(sql, { maxPendingPerOwner });
    console.info(`[bots] MySQL storage active${activation.migrated ? "; verified SQLite snapshot imported" : ""}`);
    return { driver: "mysql" as const, summary: databaseConfigurationSummary(config), store, close: () => sql.close() };
  } catch (error) {
    await sql.close();
    throw error;
  }
}
