import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CredentialKeyProvider } from "../credentials/ports.js";
import { FileCredentialKey, initializeCredentialKey } from "../credentials/file-key.js";
import { CredentialError } from "../credentials/errors.js";

/** Missing keys may be initialized only before any encrypted credential exists. */
export function connectionKey(stateRoot: string, store: { count(): number }, env: NodeJS.ProcessEnv = process.env) {
  const path = env.PANDA_FORCE_CONNECTION_KEY_FILE || join(stateRoot, "config", "connection-key");
  if (!isAbsolute(path)) throw new Error("PANDA_FORCE_CONNECTION_KEY_FILE must be an absolute path");
  const file = new FileCredentialKey(path);
  const provider: CredentialKeyProvider = {
    async load() {
      try {
        await access(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || store.count())
          throw new CredentialError("keyUnavailable");
        await initializeCredentialKey(path);
      }
      return file.load();
    },
  };
  return { path, provider };
}
