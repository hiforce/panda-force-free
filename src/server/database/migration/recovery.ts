import type { ApplicationDatabaseConfig } from "../config.js";
import {
  DatabaseManagementState,
  databaseIdentifier,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "../management/state.js";
import { startDatabaseMaintenance } from "../maintenance.js";
import { createApplicationDatabaseRegistry } from "../application-registry.js";
import { applicationMySQLRuntimeBindings } from "../runtime-stores.js";
import { executeApplicationMigration } from "./coordinator.js";
import { createLegacySQLiteMigrationSources } from "./legacy-sources.js";

export interface DatabaseRecoveryOptions {
  host: string;
  port: number;
  publicDir: string;
  projectVisibilityPath?: string;
  env?: NodeJS.ProcessEnv;
}
/** The supervisor has already waited for the previous process to exit before this can bind its maintenance port. */
export async function recoverPendingApplicationMigration(
  state: DatabaseManagementState,
  options?: DatabaseRecoveryOptions,
) {
  const pending = await state.read<{ operationId: string }>("", "pending");
  if (!pending) return;
  if (!databaseIdentifier(pending.operationId) || !options) throw Error("databaseMigrationRecoveryRequired");
  const operationId = pending.operationId,
    record = await state.read<StoredDatabaseOperation>("operations", operationId);
  if (!record || record.public.id !== operationId) throw Error("databaseMigrationRecoveryRequired");
  if (record.public.status === "complete" || record.public.status === "canceled") {
    await state.clearPending(operationId);
    return;
  }
  let wake: () => void = () => {},
    generation = 0;
  const server = await startDatabaseMaintenance({
    state,
    operationId,
    ...options,
    wake: () => {
      generation++;
      wake();
    },
  });
  try {
    for (;;) {
      const observed = generation,
        current = await state.read<StoredDatabaseOperation>("operations", operationId);
      if (!current) throw Error("databaseMigrationRecoveryRequired");
      if (current.public.status === "canceled" || current.public.status === "complete") return;
      if (current.public.status !== "failed") {
        try {
          const plan = await state.read<StoredDatabasePlan>("plans", current.planId);
          if (!plan || plan.public.source.driver !== "sqlite" || plan.config.driver !== "mysql")
            throw Error("unsupportedMigrationSource");
          const source: ApplicationDatabaseConfig = { schema: 1, driver: "sqlite" },
            sources = await createLegacySQLiteMigrationSources({
              stateRoot: state.stateRoot,
              operationId,
              current: source,
              target: plan.config,
              projectVisibilityPath: options.projectVisibilityPath,
              env: options.env,
            });
          const completed = await executeApplicationMigration({
            state,
            operationId,
            current: source,
            registry: createApplicationDatabaseRegistry(),
            runtimeBindings: new Set(applicationMySQLRuntimeBindings),
            ...sources,
            configPath: (options.env ?? process.env).PANDA_FORCE_DATABASE_CONFIG_FILE,
          });
          if (completed.status === "complete" || completed.status === "canceled") return;
        } catch (error) {
          // Driver text, connection strings and credential paths never enter the public recovery record.
          const saved = await state.read<StoredDatabaseOperation>("operations", operationId);
          if (!saved) throw Error("databaseMigrationRecoveryRequired", { cause: error });
          if (saved.public.status === "canceled" || saved.public.status === "complete") return;
          await state.write("operations", operationId, {
            ...saved,
            public: {
              ...saved.public,
              status: "failed",
              stage: "failed",
              error: {
                code:
                  error instanceof Error &&
                  ["unsupportedMigrationSource", "botDatabaseTargetMismatch"].includes(error.message)
                    ? error.message
                    : "migrationFailed",
              },
              canRetry: true,
              canCancel: false,
              updatedAt: Date.now(),
            },
          });
        }
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (generation !== observed) resolve();
      });
    }
  } finally {
    await server.close();
  }
}
