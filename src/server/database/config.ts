import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../../shared/records.js";

export type ApplicationDatabaseConfig =
  | { schema: 1; driver: "sqlite" }
  | {
      schema: 1;
      driver: "mysql";
      mysql: {
        hostname: string;
        port: number;
        database: string;
        username: string;
        password: string;
        tls: { mode: "verify"; caFile?: string } | { mode: "disabled" };
        max: number;
        connectionTimeout: number;
        idleTimeout: number;
        maxLifetime?: number;
      };
    };
export class DatabaseConfigurationError extends Error {
  constructor() {
    super("invalidDatabaseConfiguration");
  }
}
const fail = (): never => {
  throw new DatabaseConfigurationError();
};
const keys = (r: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(r).some((k) => !allowed.includes(k))) fail();
};
const bounded = (v: unknown, max: number): string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\p{Cc}]/u.test(v) ? v : fail();
const integer = (v: unknown, fallback: number, min: number, max: number) =>
  v === undefined ? fallback : typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();

/** Database selection is administrator-owned bootstrap configuration and must be recoverable without the selected database. */
export function databaseConfiguration(value: unknown): ApplicationDatabaseConfig {
  if (!isRecord(value) || value.schema !== 1 || !["sqlite", "mysql"].includes(String(value.driver))) return fail();
  keys(value, ["schema", "driver", ...(value.driver === "mysql" ? ["mysql"] : [])]);
  if (value.driver === "sqlite") return { schema: 1, driver: "sqlite" };
  const m = value.mysql;
  if (!isRecord(m)) return fail();
  keys(m, [
    "hostname",
    "port",
    "database",
    "username",
    "password",
    "tls",
    "max",
    "connectionTimeout",
    "idleTimeout",
    "maxLifetime",
  ]);
  const hostname = bounded(m.hostname, 253),
    database = bounded(m.database, 64),
    username = bounded(m.username, 128);
  if (
    !/^[a-zA-Z0-9_.:-]+$/.test(hostname) ||
    !/^[a-zA-Z0-9_]+$/.test(database) ||
    typeof m.password !== "string" ||
    m.password.length > 4096 ||
    m.password.includes("\u0000")
  )
    return fail();
  if (!isRecord(m.tls) || !["verify", "disabled"].includes(String(m.tls.mode))) return fail();
  keys(m.tls, m.tls.mode === "verify" ? ["mode", "caFile"] : ["mode"]);
  const caFile = m.tls.caFile === undefined ? undefined : bounded(m.tls.caFile, 4096);
  if (caFile && !isAbsolute(caFile)) return fail();
  return {
    schema: 1,
    driver: "mysql",
    mysql: {
      hostname,
      database,
      username,
      password: m.password,
      port: integer(m.port, 3306, 1, 65535),
      tls: m.tls.mode === "verify" ? { mode: "verify", ...(caFile ? { caFile } : {}) } : { mode: "disabled" },
      max: integer(m.max, 16, 2, 64),
      connectionTimeout: integer(m.connectionTimeout, 5, 1, 30),
      idleTimeout: integer(m.idleTimeout, 30, 5, 600),
      maxLifetime: integer(m.maxLifetime, 1800, 0, 86400),
    },
  };
}
export async function readPrivateDatabaseFile(path: string, max = 65536, privateMode = true): Promise<Buffer> {
  if (!isAbsolute(path)) return fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max || (privateMode && process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      return fail();
    const buffer = Buffer.alloc(max + 1),
      result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > max) return fail();
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
}
export async function readApplicationDatabaseConfig(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplicationDatabaseConfig> {
  const path = env.PANDA_FORCE_DATABASE_CONFIG_FILE ?? join(stateRoot, "config", "database.json");
  try {
    return databaseConfiguration(JSON.parse((await readPrivateDatabaseFile(path)).toString("utf8")));
  } catch (error) {
    if (!env.PANDA_FORCE_DATABASE_CONFIG_FILE && isRecord(error) && error.code === "ENOENT")
      return { schema: 1, driver: "sqlite" };
    throw new DatabaseConfigurationError();
  }
}
export function databaseConfigurationSummary(config: ApplicationDatabaseConfig) {
  return config.driver === "sqlite"
    ? { driver: "sqlite" as const }
    : {
        driver: "mysql" as const,
        hostname: config.mysql.hostname,
        port: config.mysql.port,
        database: config.mysql.database,
        tls: config.mysql.tls.mode,
      };
}
