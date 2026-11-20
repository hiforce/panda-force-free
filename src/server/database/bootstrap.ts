import { readApplicationDatabaseConfig } from "./config.js";
import { openApplicationDatabase } from "./provider.js";
import { DatabaseManagementState } from "./management/state.js";
import { assertApplicationDatabaseActivation } from "./migration/activation.js";
import { recoverPendingApplicationMigration, type DatabaseRecoveryOptions } from "./migration/recovery.js";

/** Resolve the administrator-owned backend before constructing any business storage. */
export async function bootstrapApplicationDatabase(
  stateRoot: string,
  options?: DatabaseRecoveryOptions & { initialChoiceRequired?: boolean },
) {
  const state = new DatabaseManagementState(stateRoot);
  if (options?.initialChoiceRequired !== undefined) await state.installation(options.initialChoiceRequired);
  await recoverPendingApplicationMigration(state, options);
  const config = await readApplicationDatabaseConfig(stateRoot, options?.env);
  const receipt = await state.read("", "activation"),
    intent = await state.read("", "activation-intent");
  if (config.driver === "mysql" && !receipt) throw Error("databaseMigrationRequired");
  if (config.driver === "sqlite" && (receipt || intent)) throw Error("databaseActivationMismatch");
  const database = await openApplicationDatabase(config);
  try {
    await assertApplicationDatabaseActivation(state, config, database.sql);
  } catch (error) {
    await database.close();
    throw error;
  }
  return { ...database, config };
}
