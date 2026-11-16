import { createMySQLAuthState } from "../auth/mysql-state.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapLocalAccounts } from "../auth/users/bootstrap.js";
import { createLocalAccountFeature } from "../auth/users/feature.js";
import { createPasswordAuth } from "../auth/routes.js";
import { createAuthState } from "../auth/state.js";
import { publicationOwner } from "../connections/integration/identity.js";
import { SQLiteLocalUsers } from "../auth/users/sqlite.js";
import type { ApplicationConfig, ApplicationStores } from "./types.js";
/** Local identity and browser authentication share one persistence selection and preserve the installation owner. */
export async function createApplicationAuthentication(
  settings: ApplicationConfig,
  runtimeStores: ApplicationStores | null,
  assertStartup: () => void,
  env: NodeJS.ProcessEnv = process.env,
) {
  const authOptions = {
    environmentPassword: settings.environmentPassword,
    accessToken: settings.accessToken,
    managedPasswordDisabled: settings.authMode === "none",
  };
  const authState = runtimeStores
    ? await createMySQLAuthState(runtimeStores.credentials, authOptions)
    : createAuthState(authOptions);
  assertStartup();
  const localUserRepository =
    settings.authMode !== "none"
      ? (runtimeStores?.users ?? new SQLiteLocalUsers(resolve(settings.stateRoot, "data", "users.sqlite")))
      : null;
  const localAccountFeature = localUserRepository
    ? createLocalAccountFeature({
        repository: localUserRepository,
        auth: authState,
        stateRoot: settings.stateRoot,
        keyPath: env.PANDA_FORCE_ACCOUNTS_KEY_FILE,
      })
    : null;
  if (env.PANDA_FORCE_LOCAL_ACCOUNT_BOOTSTRAP_FILE && localAccountFeature && localUserRepository) {
    const bootstrapFile = env.PANDA_FORCE_LOCAL_ACCOUNT_BOOTSTRAP_FILE;
    if (existsSync(bootstrapFile))
      await bootstrapLocalAccounts(bootstrapFile, authState, localUserRepository, localAccountFeature.mail);
    else if (!authState.administrator) throw new Error("Local administrator migration input is missing");
  }
  const passwordAuth = createPasswordAuth({
    authState,
    revocations: runtimeStores?.revocations,
    accounts: localAccountFeature?.accounts,
  });
  const resolveOwner = (context: Parameters<typeof publicationOwner>[1]) => publicationOwner(authState, context);

  return { authState, localAccountFeature, passwordAuth, resolveOwner };
}
