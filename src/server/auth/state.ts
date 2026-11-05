import { administratorStorePath, loadStoredAdministrator, type StoredAdministrator } from "./administrator-store.js";
import { loadStoredPassword, passwordStorePath, type StoredPassword } from "./password-store.js";
import { createStoredPassword, storedPasswordSessionSecret } from "./security.js";

/**
 * Holds administrator credentials and the legacy password used during migration.
 * A complete administrator record takes precedence over legacy browser secrets.
 */
export interface AuthState {
  readonly managedPasswordPath: string;
  readonly administratorPath: string;
  readonly administrator: StoredAdministrator | null;
  readonly managedPassword: StoredPassword | null;
  readonly secret: string | null;
  setupInProgress: boolean;
  refreshAdministrator(): void;
  adoptAdministrator(record: StoredAdministrator): void;
  legacyCredential(): StoredPassword | null;
  browserPasswordConfigured(): boolean;
  adoptManagedPassword(record: StoredPassword): void;
  reloadManagedPassword(): void;
}

export function createAuthState({
  environmentPassword,
  accessToken,
  managedPasswordDisabled,
}: {
  environmentPassword: string | null;
  accessToken: string | null;
  managedPasswordDisabled: boolean;
}): AuthState {
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
