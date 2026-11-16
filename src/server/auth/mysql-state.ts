import type { AuthState } from "./state.js";
import type { StoredPassword } from "./password-store.js";
import { createStoredPassword, storedPasswordSessionSecret } from "./security.js";
import { localAuthPaths } from "./paths.js";
import type { MySQLIdentityCredentials } from "./mysql-credentials.js";
/** Auth records are immutable once installed; bootstrap file locations never become a fallback after external selection. */
export async function createMySQLAuthState(
  store: MySQLIdentityCredentials,
  options: { environmentPassword: string | null; accessToken: string | null; managedPasswordDisabled: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthState> {
  const paths = localAuthPaths(env),
    { environmentPassword, accessToken, managedPasswordDisabled } = options;
  let administrator = managedPasswordDisabled ? null : await store.administrator(),
    managedPassword = managedPasswordDisabled || environmentPassword || accessToken ? null : await store.password(),
    setupInProgress = false;
  return {
    managedPasswordPath: paths.password,
    administratorPath: paths.administrator,
    revocationsPath: paths.revocations,
    legacyRevocationsPath: paths.legacyRevocations,
    get administrator() {
      return administrator;
    },
    get managedPassword() {
      return managedPassword;
    },
    get setupInProgress() {
      return setupInProgress;
    },
    set setupInProgress(v) {
      setupInProgress = v;
    },
    get secret() {
      return (
        storedPasswordSessionSecret(administrator?.password) ||
        environmentPassword ||
        accessToken ||
        storedPasswordSessionSecret(managedPassword)
      );
    },
    async refreshAdministrator() {
      if (!managedPasswordDisabled && !administrator) administrator = await store.administrator();
    },
    saveAdministrator: (record) => store.saveAdministrator(record),
    adoptAdministrator: (record) => {
      administrator = record;
    },
    legacyCredential() {
      const password = environmentPassword || accessToken;
      return password ? (createStoredPassword(password) as StoredPassword) : managedPassword;
    },
    browserPasswordConfigured: () => Boolean(administrator || environmentPassword || managedPassword || accessToken),
    adoptManagedPassword: (record) => {
      managedPassword = record;
    },
    async reloadManagedPassword() {
      managedPassword = managedPasswordDisabled || environmentPassword || accessToken ? null : await store.password();
    },
  };
}
