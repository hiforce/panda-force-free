import type { RouteContext } from "../../http/router.js";
import { createApplicationDatabaseRegistry } from "../application-registry.js";
import { databaseConfigurationSummary, type ApplicationDatabaseConfig } from "../config.js";
import { applicationMySQLRuntimeBindings } from "../runtime-stores.js";
import { databaseTableOwnership } from "../table-ownership.js";
import type { DatabaseTargetSummary } from "../../../shared/database/contracts.js";
import { DatabaseManagementState } from "./state.js";
import { DatabaseManagementService } from "./service.js";
import { databaseManagementRoutes } from "./routes.js";
import { inspectDatabaseTarget } from "./target.js";

/** Database administrators are an explicit system policy, independent of project memberships. */
export function databaseAdministratorAllowlist(env: NodeJS.ProcessEnv = process.env) {
  const entries = (env.PANDA_FORCE_DATABASE_ADMINISTRATORS ?? "").split(/[\s,]+/).filter(Boolean);
  if (entries.length > 100 || entries.some((id) => !/^[a-f0-9]{64}$/.test(id)))
    throw Error("invalidDatabaseAdministratorConfiguration");
  return new Set(entries);
}
export function createDatabaseManagementFeature(options: {
  stateRoot: string;
  current: ApplicationDatabaseConfig;
  bot: DatabaseTargetSummary;
  initialChoiceRequired: boolean;
  owner: (context: RouteContext) => string;
  administrator: (context: RouteContext) => boolean;
  requestRestart?: () => void;
  env?: NodeJS.ProcessEnv;
}) {
  const registry = createApplicationDatabaseRegistry(),
    state = new DatabaseManagementState(options.stateRoot),
    tables = databaseTableOwnership(registry);
  const service = new DatabaseManagementService({
    state,
    registry: () => registry,
    runtimeBindings: () => new Set(applicationMySQLRuntimeBindings),
    current: () => databaseConfigurationSummary(options.current),
    bot: () => options.bot,
    initialChoiceRequired: options.initialChoiceRequired,
    tableCount: (module) => tables.modules.get(module)?.length ?? 0,
    inspectTarget: (config) => inspectDatabaseTarget({ config, registry, state, bot: options.bot }),
    requestRestart: options.requestRestart,
  });
  return {
    service,
    state,
    ...databaseManagementRoutes({ service, owner: options.owner, administrator: options.administrator }),
  };
}
