import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existingApplicationPath, pandaEnvironment } from "../environment.js";
import { productStateRoot } from "../state-root.js";

/** Explicit locations win; existing legacy credentials are reused without moving or overwriting them. */
export function localAuthPaths(source: NodeJS.ProcessEnv = process.env) {
  const env = pandaEnvironment(source),
    root = productStateRoot(env);
  const legacyRoot = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const legacyPassword = existingApplicationPath(join(legacyRoot, "panda-force-auth.json"));
  const legacyAdministrator = env.PANDA_FORCE_ADMIN_STORE
    ? resolve(env.PANDA_FORCE_ADMIN_STORE)
    : env.PANDA_FORCE_AUTH_STORE
      ? resolve(env.PANDA_FORCE_AUTH_STORE) + ".administrator.json"
      : existingApplicationPath(join(legacyRoot, "panda-force-admin.json"));
  const prefer = (canonical: string, ...legacy: string[]) =>
    [canonical, ...legacy].find((path) => existsSync(path)) ?? canonical;
  return {
    password: env.PANDA_FORCE_AUTH_STORE
      ? resolve(env.PANDA_FORCE_AUTH_STORE)
      : prefer(join(root, "config", "password.json"), join(root, ".webui", "legacy-password.json"), legacyPassword),
    administrator:
      env.PANDA_FORCE_ADMIN_STORE || env.PANDA_FORCE_AUTH_STORE
        ? legacyAdministrator
        : prefer(
            join(root, "config", "administrator.json"),
            join(root, ".webui", "administrator.json"),
            legacyAdministrator,
          ),
    revocations: resolve(env.PANDA_FORCE_SESSION_STORE || join(root, "data", "auth-sessions.sqlite")),
    legacyRevocations: resolve(dirname(dirname(legacyAdministrator)), "data", "auth-sessions.sqlite"),
  };
}
