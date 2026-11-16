import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CredentialError } from "../credentials/errors.js";
import { FileCredentialKey, initializeCredentialKey } from "../credentials/file-key.js";
import type { CredentialKeyProvider } from "../credentials/ports.js";
import type { ConnectionPersistence } from "../persistence.js";
/** Key initialization and the encrypted-record absence check share the publication fence. Existing ciphertext can never cause a replacement key. */
export function mysqlConnectionKey(
  stateRoot: string,
  storage: ConnectionPersistence,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = env.PANDA_FORCE_CONNECTION_KEY_FILE || join(stateRoot, "config", "connection-key");
  if (!isAbsolute(path)) throw Error("PANDA_FORCE_CONNECTION_KEY_FILE must be an absolute path");
  const file = new FileCredentialKey(path),
    encryptedCount = () =>
      storage.transaction(
        async () =>
          (await storage.secrets.count()) +
          (await storage.accounts.encryptedCount()) +
          (await storage.attempts.encryptedCount()),
      );
  const provider: CredentialKeyProvider = {
    async load() {
      await storage.transaction(async () => {
        try {
          await access(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (await encryptedCount()))
            throw new CredentialError("keyUnavailable");
          await initializeCredentialKey(path);
        }
      });
      return file.load();
    },
  };
  return {
    path,
    provider,
    async ready() {
      if (await encryptedCount()) {
        const key = await provider.load();
        key.bytes.fill(0);
      }
    },
  };
}
