import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { databaseConfiguration, databaseConfigurationSummary, type ApplicationDatabaseConfig } from "../config.js";
import { connectMySQL } from "../provider.js";
import type { DatabaseRegistry } from "../registry.js";
import type {
  DatabaseConnectionInput,
  DatabaseConnectionTest,
  DatabaseIssue,
  DatabaseMigrationPlan,
  DatabaseMigrationRequest,
  DatabaseOperation,
  DatabaseOverview,
  DatabaseTargetSummary,
} from "../../../shared/database/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { DatabaseManagementError } from "./errors.js";
import {
  DatabaseManagementState,
  databaseIdentifier,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "./state.js";

const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const validStatusToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const sameTarget = (a: DatabaseTargetSummary, b: DatabaseTargetSummary) =>
  a.driver === b.driver && a.hostname === b.hostname && a.port === b.port && a.database === b.database;
export interface DatabaseManagementOptions {
  state: DatabaseManagementState;
  registry(): DatabaseRegistry;
  runtimeBindings(): ReadonlySet<string>;
  current(): DatabaseTargetSummary;
  bot?(): DatabaseTargetSummary;
  initialChoiceRequired: boolean;
  tableCount(module: string): number;
  inspectTarget?(config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>): Promise<DatabaseIssue[]>;
  connect?(config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>): Promise<SQL>;
  requestRestart?: () => void;
  resumeAfterCancel?: () => void;
}
/** The service prepares private plans; migration execution starts only in a new, fenced application process. */
export class DatabaseManagementService {
  private restartQueued = false;
  constructor(readonly options: DatabaseManagementOptions) {}
  private readiness() {
    const bindings = this.options.runtimeBindings();
    const modules = this.options
      .registry()
      .readiness("mysql")
      .map((m) => ({ ...m, readWrite: m.readWrite && (m.module === "data-migrations" || bindings.has(m.module)) }));
    const issues: DatabaseIssue[] = modules
      .filter((m) => !m.schema || !m.readWrite || !m.importer)
      .map((m) => ({ code: "incompleteDatabaseBackend", module: m.module }));
    return { ready: issues.length === 0, modules, issues };
  }
  async overview(administrator: boolean): Promise<DatabaseOverview> {
    const installation = await this.options.state.installation(this.options.initialChoiceRequired),
      current = this.options.current();
    if (!administrator)
      return {
        schema: 1,
        administrator: false,
        initialChoiceRequired: false,
        current: { driver: current.driver },
        readiness: { ready: false, modules: [], issues: [] },
      };
    await this.options.state.pruneExpiredPlans();
    const pending = await this.options.state.read<{ operationId: string }>("", "pending");
    const operation =
      pending && databaseIdentifier(pending.operationId)
        ? await this.options.state.read<StoredDatabaseOperation>("operations", pending.operationId)
        : null;
    return {
      schema: 1,
      administrator: true,
      initialChoiceRequired: installation.initialChoiceRequired,
      current,
      readiness: this.readiness(),
      ...(this.options.bot
        ? { bot: { current: this.options.bot(), preservedOnMigration: this.options.bot().driver === "mysql" } }
        : {}),
      ...(operation ? { operation: operation.public } : {}),
    };
  }
  private connection(input: DatabaseConnectionInput) {
    try {
      const config = databaseConfiguration({ schema: 1, driver: "mysql", mysql: input });
      if (config.driver !== "mysql") throw Error("Invalid selection");
      return config;
    } catch {
      throw new DatabaseManagementError("invalidDatabaseConfiguration");
    }
  }
  async test(input: DatabaseConnectionInput): Promise<DatabaseConnectionTest> {
    let sql: SQL | undefined;
    try {
      sql = await (this.options.connect ?? connectMySQL)(this.connection(input));
      const row = (await sql`SELECT VERSION() version,@@sql_mode mode`)[0];
      return {
        ok: true,
        serverVersion: String(row.version),
        strictMode: /(?:STRICT_TRANS_TABLES|STRICT_ALL_TABLES)/.test(String(row.mode)),
        issues: [],
      };
    } catch (error) {
      if (error instanceof DatabaseManagementError) throw error;
      return {
        ok: false,
        issues: [
          {
            code:
              error instanceof Error && error.message === "unsupportedDatabaseServer"
                ? "unsupportedDatabaseServer"
                : "connectionFailed",
          },
        ],
      };
    } finally {
      await sql?.close().catch(() => {});
    }
  }
  async plan(owner: string, input: DatabaseConnectionInput): Promise<DatabaseMigrationPlan> {
    await this.options.state.pruneExpiredPlans();
    const state = this.options.state,
      config = this.connection(input),
      tested = await this.test(input),
      readiness = this.readiness(),
      issues = [...tested.issues, ...readiness.issues];
    if (tested.ok && this.options.inspectTarget) issues.push(...(await this.options.inspectTarget(config)));
    if (!this.options.requestRestart) issues.push({ code: "restartUnavailable" });
    const target = databaseConfigurationSummary(config),
      bot = this.options.bot?.(),
      source = this.options.current();
    if (source.driver === "mysql") issues.push({ code: "unsupportedMigrationSource" });
    if (bot?.driver === "mysql" && !sameTarget(bot, target))
      issues.push({ code: "botDatabaseTargetMismatch", module: "bots" });
    const plan: DatabaseMigrationPlan = {
      id: randomUUID(),
      source,
      target,
      restartRequired: true,
      ready: issues.length === 0,
      modules: readiness.modules
        .filter((m) => m.module !== "data-migrations")
        .map((m) => ({
          module: m.module,
          action: m.module === "bots" && bot?.driver === "mysql" ? "preserve" : "copy",
          tableCount: this.options.tableCount(m.module),
        })),
      issues,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    await state.write("plans", plan.id, { schema: 1, owner, config, public: plan } satisfies StoredDatabasePlan);
    return plan;
  }
  private async planRecord(id: string, owner: string) {
    if (!databaseIdentifier(id)) throw new DatabaseManagementError("migrationPlanExpired", 409);
    const plan = await this.options.state.read<StoredDatabasePlan>("plans", id);
    if (
      !plan ||
      plan.schema !== 1 ||
      plan.owner !== owner ||
      plan.public?.id !== id ||
      !Number.isSafeInteger(plan.public.expiresAt) ||
      plan.public.expiresAt <= Date.now()
    )
      throw new DatabaseManagementError("migrationPlanExpired", 409);
    return plan;
  }
  async operation(id: string, statusToken: string): Promise<DatabaseOperation> {
    return (await this.authorizedOperation(id, statusToken)).public;
  }
  private async authorizedOperation(id: string, statusToken: string) {
    if (!databaseIdentifier(id) || !validStatusToken(statusToken))
      throw new DatabaseManagementError("operationTokenInvalid", 401);
    const operation = await this.options.state.read<StoredDatabaseOperation>("operations", id);
    if (!operation) throw new DatabaseManagementError("operationNotFound", 404);
    if (
      operation.schema !== 1 ||
      operation.public?.id !== id ||
      !/^[a-f0-9]{64}$/.test(operation.statusTokenHash) ||
      !Number.isSafeInteger(operation.tokenExpiresAt) ||
      !timingSafeEqual(Buffer.from(operation.statusTokenHash, "hex"), Buffer.from(tokenHash(statusToken), "hex"))
    )
      throw new DatabaseManagementError("operationTokenInvalid", 401);
    if (operation.tokenExpiresAt <= Date.now()) {
      const recoverable = ["waiting-restart", "running", "failed"].includes(operation.public.status);
      const pending = recoverable ? await this.options.state.read<{ operationId: string }>("", "pending") : null;
      // The originating capability must remain usable while this operation blocks normal administration.
      if (pending?.operationId !== id) throw new DatabaseManagementError("operationTokenInvalid", 401);
    }
    return operation;
  }
  async migrate(owner: string, input: DatabaseMigrationRequest): Promise<DatabaseOperation> {
    const { state } = this.options;
    if (!databaseIdentifier(input.requestId) || !validStatusToken(input.statusToken))
      throw new DatabaseManagementError("invalidDatabaseConfiguration");
    return state.exclusive(async () => {
      const previous = await state.read<StoredDatabaseOperation>("operations", input.requestId);
      if (previous) {
        const checked = await this.authorizedOperation(input.requestId, input.statusToken);
        if (checked.owner !== owner || checked.planId !== input.planId)
          throw new DatabaseManagementError("migrationAlreadyRunning", 409);
        if (checked.public.status === "waiting-restart") await this.claimPending(checked.public.id);
        return checked.public;
      }
      const pending = await state.read<{ operationId: string }>("", "pending");
      if (pending && pending.operationId !== input.requestId)
        throw new DatabaseManagementError("migrationAlreadyRunning", 409);
      const plan = await this.planRecord(input.planId, owner);
      if (!plan.public.ready || !this.readiness().ready)
        throw new DatabaseManagementError("incompleteDatabaseBackend", 409);
      if (!this.options.requestRestart) throw new DatabaseManagementError("restartUnavailable", 409);
      if (!sameTarget(plan.public.source, this.options.current()))
        throw new DatabaseManagementError("migrationPlanExpired", 409);
      if (this.options.current().driver === "mysql")
        throw new DatabaseManagementError("unsupportedMigrationSource", 409);
      const bot = this.options.bot?.();
      if (bot?.driver === "mysql" && !sameTarget(bot, plan.public.target))
        throw new DatabaseManagementError("botDatabaseTargetMismatch", 409);
      const now = Date.now(),
        operation: DatabaseOperation = {
          id: input.requestId,
          status: "waiting-restart",
          stage: "restart",
          source: plan.public.source,
          target: plan.public.target,
          modules: plan.public.modules.map((m) => ({
            module: m.module,
            stage: m.action === "preserve" ? "preserved" : "pending",
            rows: 0,
          })),
          startedAt: now,
          updatedAt: now,
          canRetry: false,
          canCancel: true,
        };
      await state.write("operations", operation.id, {
        schema: 1,
        owner,
        planId: input.planId,
        statusTokenHash: tokenHash(input.statusToken),
        tokenExpiresAt: now + 7 * 86400000,
        public: operation,
      } satisfies StoredDatabaseOperation);
      await this.claimPending(operation.id);
      return operation;
    });
  }
  private async claimPending(id: string) {
    const pending = await this.options.state.read<{ operationId: string }>("", "pending");
    if (pending) {
      if (pending.operationId !== id) throw new DatabaseManagementError("migrationAlreadyRunning", 409);
      return;
    }
    try {
      await this.options.state.write("", "pending", { schema: 1, operationId: id }, true);
    } catch (error) {
      if (!(isRecord(error) && error.code === "EEXIST")) throw error;
      if ((await this.options.state.read<{ operationId: string }>("", "pending"))?.operationId !== id)
        throw new DatabaseManagementError("migrationAlreadyRunning", 409);
    }
  }
  scheduleRestart(operation: DatabaseOperation) {
    if (this.restartQueued || operation.status !== "waiting-restart" || !this.options.requestRestart) return;
    this.restartQueued = true;
    setTimeout(() => {
      void this.options.state
        .read<StoredDatabaseOperation>("operations", operation.id)
        .then((current) => {
          if (current?.public.status === "waiting-restart") this.options.requestRestart?.();
          else this.restartQueued = false;
        })
        .catch(() => {
          this.restartQueued = false;
        });
    }, 50).unref();
  }
  async retry(id: string, statusToken: string) {
    return this.options.state.exclusive(async () => {
      const record = await this.authorizedOperation(id, statusToken);
      if (record.public.status === "waiting-restart") {
        await this.claimPending(id);
        return record.public;
      }
      if (record.public.status === "running") return record.public;
      if (!record.public.canRetry || record.public.status !== "failed")
        throw new DatabaseManagementError("migrationAlreadyActivated", 409);
      record.public = {
        ...record.public,
        status: "waiting-restart",
        stage: "restart",
        updatedAt: Date.now(),
        canRetry: false,
        error: undefined,
      };
      await this.claimPending(id);
      await this.options.state.write("operations", id, record);
      this.restartQueued = false;
      return record.public;
    });
  }
  async cancel(id: string, statusToken: string) {
    return this.options.state.exclusive(async () => {
      const record = await this.authorizedOperation(id, statusToken);
      if (record.public.status === "canceled") return record.public;
      if (!record.public.canCancel) throw new DatabaseManagementError("cancelRequiresAdministrator", 409);
      const pending = await this.options.state.read<{ operationId: string }>("", "pending");
      if (pending && pending.operationId !== id) throw new DatabaseManagementError("migrationAlreadyRunning", 409);
      record.public = {
        ...record.public,
        status: "canceled",
        stage: "canceled",
        updatedAt: Date.now(),
        canRetry: false,
        canCancel: false,
      };
      await this.options.state.write("operations", id, record);
      await this.options.state.clearPending(id);
      setTimeout(() => this.options.resumeAfterCancel?.(), 50).unref();
      return record.public;
    });
  }
  async selectSQLite() {
    const { state } = this.options;
    const installation = await state.installation(this.options.initialChoiceRequired);
    await state.exclusive(async () => {
      if (this.options.current().driver !== "sqlite")
        throw new DatabaseManagementError("rollbackRequiresMigration", 409);
      if (await state.read("", "pending")) throw new DatabaseManagementError("migrationAlreadyRunning", 409);
      await state.write("", "installation", { ...installation, initialChoiceRequired: false });
    });
    return this.overview(true);
  }
}
