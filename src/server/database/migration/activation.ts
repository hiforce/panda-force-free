import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { databaseConfiguration, type ApplicationDatabaseConfig } from "../config.js";
import { DatabaseManagementState, databaseIdentifier } from "../management/state.js";

type MySQLConfiguration = Extract<ApplicationDatabaseConfig, { driver: "mysql" }>;
export interface DatabaseActivation {
  schema: 1;
  installationId: string;
  operationId: string;
  targetHash: string;
}
export const databaseTargetHash = (config: MySQLConfiguration) =>
  createHash("sha256")
    .update(JSON.stringify([config.mysql.hostname.toLowerCase(), config.mysql.port, config.mysql.database]))
    .digest("hex");
const validActivation = (value: DatabaseActivation | null): value is DatabaseActivation =>
  !!value &&
  value.schema === 1 &&
  databaseIdentifier(value.installationId) &&
  databaseIdentifier(value.operationId) &&
  /^[a-f0-9]{64}$/.test(value.targetHash);

/** Claim only our explicit installation row. Existing Bot ownership must have the same installation identity. */
export async function claimApplicationDatabase(sql: SQL, activation: DatabaseActivation) {
  if (!validActivation(activation)) throw Error("invalidDatabaseActivation");
  const hasBot = (
    await sql`SELECT 1 found FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='panda_force_bot_control'`
  ).length;
  if (hasBot) {
    const bot = (await sql`SELECT value FROM panda_force_bot_control WHERE name='installation'`)[0];
    if (bot) {
      let owner: unknown;
      try {
        owner = JSON.parse(bot.value);
      } catch {
        throw Error("migrationTargetAlreadyOwned");
      }
      if (!owner || typeof owner !== "object" || !("id" in owner) || owner.id !== activation.installationId)
        throw Error("migrationTargetAlreadyOwned");
    }
  }
  await sql.begin(async (tx) => {
    await tx`INSERT INTO panda_force_database_installation(id,installationId,operationId,state,targetHash,updatedAt) VALUES(1,${activation.installationId},${activation.operationId},'staging',${activation.targetHash},${Date.now()}) ON DUPLICATE KEY UPDATE id=id`;
    const saved = (
      await tx`SELECT installationId,operationId,targetHash,state FROM panda_force_database_installation WHERE id=1 FOR UPDATE`
    )[0];
    if (
      saved?.installationId !== activation.installationId ||
      saved.operationId !== activation.operationId ||
      saved.targetHash !== activation.targetHash ||
      !["staging", "active"].includes(saved.state)
    )
      throw Error("migrationTargetAlreadyOwned");
  });
}

/** A committed activation intent prevents falling back to stale SQLite after any interrupted selector write. */
export async function activateApplicationDatabase(options: {
  sql: SQL;
  state: DatabaseManagementState;
  activation: DatabaseActivation;
  config: MySQLConfiguration;
  configPath?: string;
}) {
  const { sql, state, activation } = options,
    config = databaseConfiguration(options.config);
  if (config.driver !== "mysql" || databaseTargetHash(config) !== activation.targetHash || !validActivation(activation))
    throw Error("invalidDatabaseActivation");
  const intent = await state.read<DatabaseActivation>("", "activation-intent");
  if (intent && (!validActivation(intent) || JSON.stringify(intent) !== JSON.stringify(activation)))
    throw Error("databaseActivationMismatch");
  await state.write("", "activation-intent", activation);
  await sql.begin(async (tx) => {
    const current = (
      await tx`SELECT installationId,operationId,targetHash FROM panda_force_database_installation WHERE id=1 FOR UPDATE`
    )[0];
    if (
      current?.installationId !== activation.installationId ||
      current.operationId !== activation.operationId ||
      current.targetHash !== activation.targetHash
    )
      throw Error("databaseActivationMismatch");
    await tx`UPDATE panda_force_database_installation SET state='active',updatedAt=${Date.now()} WHERE id=1`;
  });
  const path = options.configPath ?? join(state.stateRoot, "config", "database.json");
  if (!isAbsolute(path)) throw Error("invalidDatabaseConfiguration");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("invalidDatabaseConfiguration");
  const temporary = path + "." + randomUUID(),
    file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    await file.writeFile(JSON.stringify(config));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  await state.write("", "activation", activation);
  const installation = await state.installation(false);
  if (installation.id !== activation.installationId) throw Error("databaseActivationMismatch");
  await state.write("", "installation", { ...installation, initialChoiceRequired: false });
}

/** This check runs before constructors and workers, including when the selector was deleted or changed. */
export async function assertApplicationDatabaseActivation(
  state: DatabaseManagementState,
  config: ApplicationDatabaseConfig,
  sql: SQL | null,
) {
  const active = await state.read<DatabaseActivation>("", "activation"),
    intent = await state.read<DatabaseActivation>("", "activation-intent");
  if (!active && !intent) {
    if (config.driver === "mysql") throw Error("databaseMigrationRequired");
    return;
  }
  if (
    !validActivation(active) ||
    !validActivation(intent) ||
    JSON.stringify(active) !== JSON.stringify(intent) ||
    config.driver !== "mysql" ||
    !sql ||
    databaseTargetHash(config) !== active.targetHash
  )
    throw Error("databaseActivationMismatch");
  const installation = await state.installation(false);
  const saved = (
    await sql`SELECT installationId,operationId,state,targetHash FROM panda_force_database_installation WHERE id=1`
  )[0];
  if (
    installation.id !== active.installationId ||
    saved?.installationId !== active.installationId ||
    saved.operationId !== active.operationId ||
    saved.targetHash !== active.targetHash ||
    saved.state !== "active"
  )
    throw Error("databaseActivationMismatch");
}
