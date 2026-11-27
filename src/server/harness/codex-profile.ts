import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errorCode } from "../../shared/errors.js";
import type { EngineDriver } from "../../shared/engine/contracts.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import { isRecord } from "../../shared/records.js";
import { createCodexDriver } from "../engines/codex.js";
import { CodexHarnessAgent } from "./adapters/codex.js";
import type { HarnessAgentFactory } from "./ports.js";

async function readSettings(path: string, maximumBytes: number) {
  const file = await open(path, "r").catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new HarnessError("unavailable");
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) throw new HarnessError("unavailable");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function publishSettings(path: string, target: string, value: string | undefined) {
  if (value === undefined) {
    await rm(path, { force: true });
    return;
  }
  const temporary = path + "." + randomUUID();
  try {
    await writeFile(target, value, { mode: 0o600, flag: "wx" });
    await symlink(target, temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function accessExpiresSoon(token: string) {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return isRecord(claims) && typeof claims.exp === "number" && claims.exp * 1000 <= Date.now() + 60_000;
  } catch {
    return false;
  }
}

function readAccount(raw: string | undefined) {
  if (raw === undefined) return { identity: "configured-provider" };
  try {
    const auth: unknown = JSON.parse(raw);
    if (!isRecord(auth)) throw new Error("Invalid Codex account storage");
    if (typeof auth.OPENAI_API_KEY === "string" && !isRecord(auth.tokens))
      return {
        identity: createHash("sha256").update(auth.OPENAI_API_KEY).digest("hex"),
        snapshot: JSON.stringify({ auth_mode: auth.auth_mode, OPENAI_API_KEY: auth.OPENAI_API_KEY }),
      };
    if (isRecord(auth.tokens)) {
      const { access_token, account_id, id_token, login_owner_id } = auth.tokens;
      if (typeof access_token !== "string" || typeof id_token !== "string" || typeof account_id !== "string")
        throw new Error("Incomplete Codex account storage");
      return {
        identity: account_id + "\0" + (typeof login_owner_id === "string" ? login_owner_id : ""),
        needsRefresh: accessExpiresSoon(access_token),
        snapshot: JSON.stringify({
          auth_mode: auth.auth_mode,
          last_refresh: auth.last_refresh,
          tokens: { access_token, account_id, id_token, login_owner_id, refresh_token: "" },
        }),
      };
    }
    if (Object.keys(auth).length === 0) return { identity: "configured-provider" };
  } catch {}
  throw new HarnessError("authentication");
}

function managedEnvironment(env: NodeJS.ProcessEnv, home: string, configuration: string | undefined) {
  const names = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SHELL",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "NODE_PATH",
    "PANDA_FORCE_CREATIVE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
  ];
  if (configuration) {
    const config: unknown = Bun.TOML.parse(configuration);
    if (isRecord(config) && isRecord(config.model_providers))
      for (const provider of Object.values(config.model_providers))
        if (isRecord(provider) && typeof provider.env_key === "string") names.push(provider.env_key);
  }
  return Object.assign(Object.fromEntries(names.map((name) => [name, env[name]])), {
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
  });
}

/** Managed rollouts live in application state and their workers never own the shared login refresh token. */
export function managedCodexFactory(
  stateRoot: string,
  accountDriver: EngineDriver,
  env: NodeJS.ProcessEnv,
): HarnessAgentFactory {
  const source = resolve(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"));
  const accountFile = join(source, "auth.json");
  let refresh: Promise<unknown> | undefined;
  return {
    async create(runtime, scope) {
      if (!scope.persistentConversation) return new CodexHarnessAgent(accountDriver);
      let account = readAccount(await readSettings(accountFile, 128 * 1024));
      if (account.needsRefresh) {
        refresh ??= accountDriver.execute("account.read", { refreshToken: true }).finally(() => (refresh = undefined));
        await refresh.catch(() => {
          throw new HarnessError("authentication");
        });
        account = readAccount(await readSettings(accountFile, 128 * 1024));
        if (!account.snapshot || account.needsRefresh) throw new HarnessError("authentication");
      }
      const key = createHash("sha256")
        .update(JSON.stringify([runtime.id, scope.owner, scope.scopeId, account.identity]))
        .digest("hex");
      const home = resolve(stateRoot, "harness", "native", "codex", key);
      await mkdir(home, { recursive: true, mode: 0o700 });
      if ((await realpath(home)) !== home) throw new HarnessError("forbidden", 403);
      await chmod(home, 0o700);
      const configuration = await readSettings(join(source, "config.toml"), 256 * 1024);
      const processEnvironment = managedEnvironment(env, home, configuration);
      const transient = await mkdtemp(join(tmpdir(), "panda-codex-settings-"));
      const cleanup = () => rm(transient, { recursive: true, force: true });
      try {
        await publishSettings(join(home, "config.toml"), join(transient, "config.toml"), configuration);
        await publishSettings(join(home, "auth.json"), join(transient, "auth.json"), account.snapshot);
      } catch (error) {
        await cleanup();
        throw error;
      }
      let closed = false;
      const driver = createCodexDriver({
        connection: { mode: "isolated" },
        defaultCwd: scope.cwd,
        processEnvironment,
        processArguments: [
          "-c",
          "sqlite_home=" + JSON.stringify(home),
          ...(account.snapshot ? ["-c", 'cli_auth_credentials_store="file"'] : []),
        ],
        version: "1",
        isShuttingDown: () => closed,
      });
      return new CodexHarnessAgent(
        driver,
        async () => {
          if (closed) return;
          closed = true;
          driver.cancelRestart();
          driver.stop();
          for (let attempt = 0; attempt < 10 && !driver.fullyStopped(); attempt++) await Bun.sleep(25);
          if (!driver.fullyStopped()) driver.stop("SIGKILL");
          await cleanup();
        },
        true,
      );
    },
  };
}
