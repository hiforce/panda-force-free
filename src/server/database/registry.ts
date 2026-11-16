import { createHash } from "node:crypto";

export type DatabaseDialect = "sqlite" | "mysql";
export interface SchemaColumn {
  name: string;
  nullable: boolean;
  type: string;
  collation?: string | null;
  autoIncrement?: boolean;
  defaultValue?: string | number | null;
}
export interface SchemaIndex {
  name: string;
  unique: boolean;
  columns: string[];
}
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
}
export interface SchemaStep {
  id: string;
  sql: string;
  // A postcondition makes a committed MySQL DDL step safe to resume after interruption.
  satisfied(connection: SchemaConnection): Promise<boolean>;
}
export interface SchemaMigration {
  version: number;
  steps: readonly SchemaStep[];
  // Exact plans shipped under this version remain resumable without rewriting their journal.
  historicalSteps?: readonly (readonly SchemaStep[])[];
}
export interface DatabaseModule {
  id: string;
  dependencies: readonly string[];
  migrations: Partial<Record<DatabaseDialect, readonly SchemaMigration[]>>;
  backends?: Partial<Record<DatabaseDialect, { readWrite: boolean; importFrom: readonly DatabaseDialect[] }>>;
  inspect(connection: SchemaConnection): Promise<SchemaIssue[]>;
}
export interface SchemaIssue {
  module: string;
  object: string;
  code:
    | "missingTable"
    | "missingColumn"
    | "missingIndex"
    | "incompatibleColumn"
    | "incompatibleIndex"
    | "migrationIncomplete"
    | "changedMigration"
    | "unsupportedVersion";
}
export interface MigrationRecord {
  version: number;
  checksum: string;
  step: number;
  state: "running" | "complete" | "failed";
}
export interface SchemaConnection {
  readonly dialect: DatabaseDialect;
  execute(sql: string): Promise<void>;
  table(name: string): Promise<boolean>;
  column(table: string, column: string): Promise<boolean>;
  index(table: string, index: string): Promise<boolean>;
  describe(table: string): Promise<SchemaTable | null>;
  history(module: string, version: number): Promise<MigrationRecord | null>;
  record(module: string, value: MigrationRecord): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
export class SchemaError extends Error {
  constructor(
    public code:
      | "duplicateModule"
      | "missingDependency"
      | "dependencyCycle"
      | "missingDialect"
      | "missingBackend"
      | "missingImporter"
      | "invalidMigration"
      | "unsafeStatement"
      | "changedMigration"
      | "unsupportedVersion"
      | "schemaDrift",
    public module: string,
  ) {
    super(code);
  }
}
export const migrationChecksum = (module: string, migration: SchemaMigration) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        module,
        version: migration.version,
        steps: migration.steps.map(({ id, sql }) => ({ id, sql })),
      }),
    )
    .digest("hex");

function recordedPlan(module: string, migration: SchemaMigration, checksum: string) {
  for (const steps of [migration.steps, ...(migration.historicalSteps ?? [])]) {
    const plan = { version: migration.version, steps };
    if (migrationChecksum(module, plan) === checksum) return plan;
  }
  return undefined;
}

/** Registrations are explicit. An unavailable module backend blocks a whole-application cutover. */
export class DatabaseRegistry {
  private modules = new Map<string, DatabaseModule>();
  register(module: DatabaseModule) {
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(module.id) || this.modules.has(module.id))
      throw new SchemaError("duplicateModule", module.id);
    for (const migrations of Object.values(module.migrations)) {
      for (const [index, migration] of migrations.entries()) {
        if (migration.version !== index + 1) throw new SchemaError("invalidMigration", module.id);
        for (const steps of [migration.steps, ...(migration.historicalSteps ?? [])]) {
          if (!steps.length || new Set(steps.map((s) => s.id)).size !== steps.length)
            throw new SchemaError("invalidMigration", module.id);
          for (const step of steps) {
            // Automatic upgrades accept additive DDL only. Data rewrites use separately reviewed migration jobs.
            const sql = step.sql.replace(/--[^\n]*/g, "").trim();
            if (
              !/^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE\s+[`\w]+\s+ADD (?:COLUMN|INDEX|KEY|UNIQUE))\b/i.test(
                sql,
              ) ||
              /\b(?:DROP|TRUNCATE|RENAME|DELETE|REPLACE)\b/i.test(sql) ||
              sql.replace(/;\s*$/, "").includes(";")
            )
              throw new SchemaError("unsafeStatement", module.id);
          }
        }
      }
    }
    const migrations: DatabaseModule["migrations"] = {};
    for (const [dialect, versions] of Object.entries(module.migrations)) {
      migrations[dialect as DatabaseDialect] = versions.map((version) => ({
        version: version.version,
        steps: version.steps.map((step) => ({ ...step })),
        ...(version.historicalSteps
          ? { historicalSteps: version.historicalSteps.map((steps) => steps.map((step) => ({ ...step }))) }
          : {}),
      }));
    }
    for (const versions of Object.values(migrations)) {
      for (const version of versions) {
        for (const steps of [version.steps, ...(version.historicalSteps ?? [])]) {
          for (const step of steps) Object.freeze(step);
          Object.freeze(steps);
        }
        if (version.historicalSteps) Object.freeze(version.historicalSteps);
        Object.freeze(version);
      }
      Object.freeze(versions);
    }
    const backends: DatabaseModule["backends"] = {};
    for (const [dialect, backend] of Object.entries(module.backends ?? {}))
      backends[dialect as DatabaseDialect] = Object.freeze({
        ...backend,
        importFrom: Object.freeze([...backend.importFrom]),
      });
    this.modules.set(
      module.id,
      Object.freeze({
        ...module,
        dependencies: Object.freeze([...module.dependencies]),
        migrations: Object.freeze(migrations),
        backends: Object.freeze(backends),
      }),
    );
    return this;
  }
  ordered() {
    const complete = new Set<string>(),
      visiting = new Set<string>(),
      ordered: DatabaseModule[] = [];
    const visit = (id: string) => {
      if (complete.has(id)) return;
      const module = this.modules.get(id);
      if (!module) throw new SchemaError("missingDependency", id);
      if (visiting.has(id)) throw new SchemaError("dependencyCycle", id);
      visiting.add(id);
      for (const dep of module.dependencies) visit(dep);
      visiting.delete(id);
      complete.add(id);
      ordered.push(module);
    };
    for (const id of this.modules.keys()) visit(id);
    return ordered;
  }
  readiness(dialect: DatabaseDialect, source: DatabaseDialect = "sqlite") {
    return this.ordered().map((m) => ({
      module: m.id,
      schema: !!m.migrations[dialect]?.length,
      readWrite: m.backends?.[dialect]?.readWrite === true,
      importer: source === dialect || m.backends?.[dialect]?.importFrom.includes(source) === true,
    }));
  }
  assertCutoverReady(dialect: DatabaseDialect, source: DatabaseDialect = "sqlite") {
    for (const module of this.readiness(dialect, source)) {
      if (!module.schema) throw new SchemaError("missingDialect", module.module);
      if (!module.readWrite) throw new SchemaError("missingBackend", module.module);
      if (!module.importer) throw new SchemaError("missingImporter", module.module);
    }
  }
  async inspect(connection: SchemaConnection) {
    const issues: SchemaIssue[] = [];
    const journal = await connection.table("panda_force_schema_migrations");
    for (const module of this.ordered()) {
      const migrations = module.migrations[connection.dialect] ?? [];
      if (!migrations.length)
        issues.push({ module: module.id, object: connection.dialect, code: "migrationIncomplete" });
      if (!journal) {
        for (const migration of migrations)
          issues.push({ module: module.id, object: String(migration.version), code: "migrationIncomplete" });
      } else {
        const latest = await connection.history(module.id, 0);
        if (latest && latest.version > migrations.length)
          issues.push({ module: module.id, object: "version", code: "unsupportedVersion" });
        for (const migration of migrations) {
          const saved = await connection.history(module.id, migration.version);
          if (saved && !recordedPlan(module.id, migration, saved.checksum))
            issues.push({ module: module.id, object: String(migration.version), code: "changedMigration" });
          if (!saved || saved.state !== "complete")
            issues.push({ module: module.id, object: String(migration.version), code: "migrationIncomplete" });
        }
      }
      issues.push(...(await module.inspect(connection)));
    }
    return issues;
  }
  async upgrade(
    connection: SchemaConnection,
    progress: (value: { module: string; version: number; step: number; total: number }) => void = () => {},
  ) {
    const modules = this.ordered();
    for (const module of modules)
      if (!module.migrations[connection.dialect]?.length) throw new SchemaError("missingDialect", module.id);
    return connection.exclusive(async () => {
      for (const module of modules) {
        const migrations = module.migrations[connection.dialect]!;
        const latest = await connection.history(module.id, 0);
        if (latest && latest.version > migrations.length) throw new SchemaError("unsupportedVersion", module.id);
        for (const migration of migrations) {
          const previous = await connection.history(module.id, migration.version),
            plan = previous ? recordedPlan(module.id, migration, previous.checksum) : migration;
          if (!plan) throw new SchemaError("changedMigration", module.id);
          const checksum = migrationChecksum(module.id, plan);
          if (
            previous &&
            (!Number.isSafeInteger(previous.step) || previous.step < 0 || previous.step > plan.steps.length)
          )
            throw new SchemaError("invalidMigration", module.id);
          if (previous?.state === "complete") continue;
          let step = previous?.step ?? 0;
          try {
            await connection.record(module.id, { version: migration.version, checksum, step, state: "running" });
            for (; step < plan.steps.length; step++) {
              const entry = plan.steps[step]!;
              if (!(await entry.satisfied(connection))) await connection.execute(entry.sql);
              if (!(await entry.satisfied(connection))) throw new SchemaError("schemaDrift", module.id);
              await connection.record(module.id, {
                version: migration.version,
                checksum,
                step: step + 1,
                state: "running",
              });
              progress({
                module: module.id,
                version: migration.version,
                step: step + 1,
                total: plan.steps.length,
              });
            }
            await connection.record(module.id, { version: migration.version, checksum, step, state: "complete" });
          } catch (error) {
            await connection.record(module.id, { version: migration.version, checksum, step, state: "failed" });
            throw error;
          }
        }
        if ((await module.inspect(connection)).length) throw new SchemaError("schemaDrift", module.id);
      }
      return this.inspect(connection);
    });
  }
}
