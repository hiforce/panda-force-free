import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseOperation } from "../../../shared/database/contracts.js";
import { databaseConfiguration, databaseConfigurationSummary, type ApplicationDatabaseConfig } from "../config.js";
import {
  DatabaseManagementState,
  databaseIdentifier,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "../management/state.js";
import { connectMySQL } from "../provider.js";
import { MySQLSchemaConnection } from "../mysql-schema.js";
import type { DatabaseRegistry } from "../registry.js";
import type { MigrationProgress } from "../data-migration.js";
import {
  activateApplicationDatabase,
  claimApplicationDatabase,
  databaseTargetHash,
  type DatabaseActivation,
} from "./activation.js";
import { verifyFrozenSQLiteSource, synchronizeFrozenSourceDirectories, type FrozenSQLiteSource } from "./snapshot.js";
import { databaseTableOwnership } from "../table-ownership.js";
import { inspectDatabaseTarget } from "../management/target.js";
import { assertApplicationMigrationLease, withApplicationMigrationLease } from "./lease.js";

export interface ApplicationMigrationUnit {
  id: string;
  module: string;
  source: string;
  targetTables: readonly string[];
  copy(options: {
    sql: SQL;
    connection?: Awaited<ReturnType<SQL["reserve"]>>;
    snapshotPath: string;
    migrationId: string;
    progress: (value: MigrationProgress) => Promise<void>;
  }): Promise<unknown>;
}
export interface ApplicationMigrationManifest {
  schema: 1;
  operationId: string;
  sources: FrozenSQLiteSource[];
  preservedModules: string[];
  unitsFingerprint: string;
}
export const migrationUnitsFingerprint = (units: readonly ApplicationMigrationUnit[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        units
          .map(({ id, module, source, targetTables }) => ({
            id,
            module,
            source,
            targetTables: [...targetTables].sort(),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest("hex");
export interface ApplicationMigrationOptions {
  state: DatabaseManagementState;
  operationId: string;
  registry: DatabaseRegistry;
  runtimeBindings: ReadonlySet<string>;
  current: ApplicationDatabaseConfig;
  units: readonly ApplicationMigrationUnit[];
  /** Called only after the old process and its application-owned workers stopped. */
  prepare(directory: string): Promise<ApplicationMigrationManifest>;
  connect?: (config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>) => Promise<SQL>;
  configPath?: string;
  verifyPreservedModules?: (sql: SQL) => Promise<void>;
}
const publicFailure = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return new Set([
    "migrationSourceChanged",
    "migrationVerificationFailed",
    "migrationRecordTooLarge",
    "migrationPacketLimitTooSmall",
    "migrationTargetAlreadyOwned",
    "incompleteDatabaseBackend",
    "botDatabaseTargetMismatch",
  ]).has(code)
    ? code
    : "migrationFailed";
};

/** Runtime coordination rows are recreated by their repositories, rather than copied as business data. */
export function isApplicationMigrationControlTable(table: string) {
  return (
    /(?:_mutex|_guard)$/.test(table) ||
    [
      "panda_force_bot_control",
      "panda_force_cli_control",
      "panda_force_skill_workspace_controls",
      "panda_force_gadget_workspace_controls",
    ].includes(table)
  );
}

/** No workers start here. A failed copy remains an inactive, resumable target with its original frozen sources. */
export async function executeApplicationMigration(options: ApplicationMigrationOptions): Promise<DatabaseOperation> {
  const { state, operationId, registry } = options;
  if (!databaseIdentifier(operationId)) throw Error("operationNotFound");
  let record = await state.read<StoredDatabaseOperation>("operations", operationId);
  if (!record || record.schema !== 1 || record.public.id !== operationId) throw Error("operationNotFound");
  if (record.public.status === "complete" || record.public.status === "canceled") return record.public;
  const pending = await state.read<{ operationId: string }>("", "pending");
  if (pending?.operationId !== operationId) throw Error("migrationAlreadyRunning");
  const plan = await state.read<StoredDatabasePlan>("plans", record.planId);
  if (!plan || plan.owner !== record.owner || !plan.public.ready || plan.public.id !== record.planId)
    throw Error("migrationPlanExpired");
  const config = databaseConfiguration(plan.config);
  if (config.driver !== "mysql") throw Error("invalidDatabaseConfiguration");
  if (JSON.stringify(databaseConfigurationSummary(options.current)) !== JSON.stringify(plan.public.source))
    throw Error("migrationSourceChanged");
  const write = async (patch: Partial<DatabaseOperation>) => {
    const updated = { ...record!, public: { ...record!.public, ...patch, updatedAt: Date.now() } };
    await state.write("operations", operationId, updated);
    record = updated;
  };
  let sql: SQL | undefined, lease: Awaited<ReturnType<SQL["reserve"]>> | undefined;
  try {
    registry.assertCutoverReady("mysql", options.current.driver);
    if (
      registry.readiness("mysql").some((m) => m.module !== "data-migrations" && !options.runtimeBindings.has(m.module))
    )
      throw Error("incompleteDatabaseBackend");
    const started = await state.exclusive(async () => {
      const latest = await state.read<StoredDatabaseOperation>("operations", operationId);
      if (!latest) throw Error("operationNotFound");
      record = latest;
      if (latest.public.status === "canceled" || latest.public.status === "complete") return false;
      if ((await state.read<{ operationId: string }>("", "pending"))?.operationId !== operationId)
        throw Error("migrationAlreadyRunning");
      await write({ status: "running", stage: "validate", canCancel: false, canRetry: false, error: undefined });
      return true;
    });
    if (!started) return record.public;
    const planned = new Set(plan.public.modules.map((m) => m.module));
    const ownership = databaseTableOwnership(registry);
    if (registry.ordered().some((m) => m.id !== "data-migrations" && !planned.has(m.id)))
      throw Error("incompleteDatabaseBackend");
    const copied = options.units.flatMap((u) => u.targetTables.map((table) => ({ unit: u, table })));
    if (
      copied.some(({ unit, table }) => ownership.owners.get(table) !== unit.module) ||
      new Set(copied.map((c) => c.table)).size !== copied.length
    )
      throw Error("incompleteDatabaseBackend");
    for (const m of plan.public.modules.filter((m) => m.action === "copy"))
      for (const table of ownership.modules.get(m.module) ?? []) {
        if (
          !isApplicationMigrationControlTable(table) &&
          !copied.some((c) => c.unit.module === m.module && c.table === table)
        )
          throw Error("incompleteDatabaseBackend");
      }
    sql = await (options.connect ?? connectMySQL)(config);
    const targetIssues = await inspectDatabaseTarget({
      sql,
      config,
      registry,
      state,
      allowedOperationId: operationId,
      ...(plan.public.modules.some((m) => m.module === "bots" && m.action === "preserve")
        ? { bot: plan.public.target }
        : {}),
    });
    if (targetIssues.length) throw Error(targetIssues[0]!.code);
    await write({ stage: "schema" });
    const issues = await registry.upgrade(new MySQLSchemaConnection(sql));
    if (issues.length) throw Error("migrationVerificationFailed");
    lease = await sql.reserve();
    if (
      Number((await lease`SELECT GET_LOCK(CONCAT('pf-app:',LEFT(SHA2(DATABASE(),256),40)),0) acquired`)[0].acquired) !==
      1
    )
      throw Error("migrationAlreadyRunning");
    const installation = await state.installation(false),
      activation: DatabaseActivation = {
        schema: 1,
        installationId: installation.id,
        operationId,
        targetHash: databaseTargetHash(config),
      };
    if (plan.public.modules.some((m) => m.action === "preserve")) {
      if (!options.verifyPreservedModules) throw Error("incompleteDatabaseBackend");
      await options.verifyPreservedModules(lease);
    }
    await claimApplicationDatabase(lease, activation);
    let manifest = await state.read<ApplicationMigrationManifest>("", "sources-" + operationId);
    if (!manifest) {
      await write({ stage: "backup" });
      const root = await state.directory("migrations"),
        directory = join(root, operationId + "-" + randomUUID());
      await mkdir(directory, { mode: 0o700 });
      manifest = await withApplicationMigrationLease(lease, config.mysql.idleTimeout, () => options.prepare(directory));
      await withApplicationMigrationLease(lease, config.mysql.idleTimeout, () =>
        synchronizeFrozenSourceDirectories(manifest!.sources, state.root),
      );
      await state.write("", "sources-" + operationId, manifest, true);
    }
    if (
      manifest.schema !== 1 ||
      manifest.operationId !== operationId ||
      manifest.unitsFingerprint !== migrationUnitsFingerprint(options.units) ||
      new Set(manifest.sources.map((s) => s.id)).size !== manifest.sources.length
    )
      throw Error("migrationSourceChanged");
    if (
      JSON.stringify([...manifest.preservedModules].sort()) !==
      JSON.stringify(
        plan.public.modules
          .filter((m) => m.action === "preserve")
          .map((m) => m.module)
          .sort(),
      )
    )
      throw Error("migrationSourceChanged");
    const modules = plan.public.modules.filter((m) => m.action === "copy").map((m) => m.module);
    if (modules.some((id) => !options.units.some((u) => u.module === id))) throw Error("incompleteDatabaseBackend");
    if (new Set(options.units.map((u) => u.id)).size !== options.units.length) throw Error("incompleteDatabaseBackend");
    await withApplicationMigrationLease(lease, config.mysql.idleTimeout, async () => {
      for (const source of manifest.sources) await verifyFrozenSQLiteSource(source);
    });
    // Per-table counts are accumulated without replacing another table's progress.
    const rowCounts = new Map<string, number>();
    for (const unit of options.units) {
      if (!modules.includes(unit.module)) continue;
      const source = manifest.sources.find((s) => s.id === unit.source);
      if (!source) throw Error("migrationSourceChanged");
      await withApplicationMigrationLease(lease, config.mysql.idleTimeout, () => verifyFrozenSQLiteSource(source));
      await write({ stage: "copy" });
      await unit.copy({
        sql,
        connection: lease,
        snapshotPath: source.snapshotPath,
        migrationId: operationId,
        progress: async (value) => {
          await assertApplicationMigrationLease(lease!);
          if (value.table) rowCounts.set(unit.id + ":" + value.table, value.rows);
          const rows = [...rowCounts]
            .filter(([key]) => options.units.some((u) => u.module === unit.module && key.startsWith(u.id + ":")))
            .reduce((sum, [, value]) => sum + value, 0);
          await write({
            stage: value.stage === "copy" ? "copy" : "verify",
            modules: record!.public.modules.map((m) =>
              m.module === unit.module ? { ...m, stage: value.stage === "copy" ? "copy" : "verify", rows } : m,
            ),
          });
        },
      });
    }
    await withApplicationMigrationLease(lease, config.mysql.idleTimeout, async () => {
      for (const source of manifest.sources) await verifyFrozenSQLiteSource(source);
    });
    await write({
      stage: "activate",
      modules: record.public.modules.map((m) => ({ ...m, stage: m.stage === "preserved" ? "preserved" : "complete" })),
    });
    await activateApplicationDatabase({ sql: lease, state, activation, config, configPath: options.configPath });
    await write({ status: "complete", stage: "complete", canRetry: false, canCancel: false });
    await state.clearPending(operationId);
    return record.public;
  } catch (error) {
    return await state.exclusive(async () => {
      const latest = await state.read<StoredDatabaseOperation>("operations", operationId);
      if (!latest) throw Error("databaseMigrationRecoveryRequired", { cause: error });
      record = latest;
      if (record.public.status === "complete" || record.public.status === "canceled") return record.public;
      await write({
        status: "failed",
        stage: "failed",
        error: { code: publicFailure(error) },
        canRetry: true,
        canCancel: false,
      });
      return record.public;
    });
  } finally {
    if (lease) {
      try {
        await lease`SELECT RELEASE_LOCK(CONCAT('pf-app:',LEFT(SHA2(DATABASE(),256),40)))`;
      } catch {}
      try {
        lease.release();
      } catch {
        console.warn("[database] Migration connection release could not complete");
      }
    }
    try {
      await sql?.close();
    } catch {
      console.warn("[database] Migration connection cleanup could not complete");
    }
  }
}
