import { loadStoredPassword, passwordStorePath, type StoredPassword } from "./password-store.js";
import { createStoredPassword, storedPasswordSessionSecret } from "./security.js";
import { administratorStorePath, loadStoredAdministrator, type StoredAdministrator } from "./administrator-store.js";

/**
 * Holds administrator credentials and the legacy password used during migration.
 * A complete administrator record takes precedence over legacy browser secrets.
 */
export function createAuthState({
  environmentPassword,
  accessToken,
  managedPasswordDisabled,
}: {
  environmentPassword: string | null;
  accessToken: string | null;
  managedPasswordDisabled: boolean;
}) {
  const managedPasswordPath = passwordStorePath();
  const administratorPath = administratorStorePath();
  let administrator = managedPasswordDisabled ? null : loadStoredAdministrator(administratorPath);
  let managedPassword: StoredPassword | null =
    managedPasswordDisabled || environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
  let setupInProgress = false;

  return {
    managedPasswordPath,
    administratorPath,
    get administrator() {
      return administrator;
    },
    refreshAdministrator() {
      if (!managedPasswordDisabled && !administrator) administrator = loadStoredAdministrator(administratorPath);
    },
    adoptAdministrator(record: StoredAdministrator) {
      administrator = record;
    },
    legacyCredential(): StoredPassword | null {
      const password = environmentPassword || accessToken;
      return password ? (createStoredPassword(password) as StoredPassword) : managedPassword;
    },
    get managedPassword() {
      return managedPassword;
    },
    get secret() {
      return (
        storedPasswordSessionSecret(administrator?.password) ||
        environmentPassword ||
        accessToken ||
        storedPasswordSessionSecret(managedPassword)
      );
    },
    get setupInProgress() {
      return setupInProgress;
    },
    set setupInProgress(value: boolean) {
      setupInProgress = value;
    },
    browserPasswordConfigured() {
      return Boolean(administrator || environmentPassword || managedPassword || accessToken);
    },
    adoptManagedPassword(credential: StoredPassword) {
      managedPassword = credential;
    },
    reloadManagedPassword() {
      managedPassword = loadStoredPassword(managedPasswordPath);
    },
  };
}

export type AuthState = ReturnType<typeof createAuthState>;
