import { createHash, randomUUID } from "node:crypto";
import { existsSync, constants } from "node:fs";
import { chmod, mkdir, readFile, open, realpath, mkdtemp, rm, unlink, rename } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { HarnessError } from "../../shared/harness/contracts.js";
import { isRecord } from "../../shared/records.js";
import type { EngineDriver } from "../../shared/engine/contracts.js";
import type { HarnessProfile } from "./registry.js";
import { CodexHarnessAgent } from "./adapters/codex.js";
import { GrokHarnessAgent } from "./adapters/grok.js";
import { accessCredentials } from "./auth/snapshot.js";
import { brokerCredentialSource, credentialLease } from "./auth/remote.js";
import type { HarnessCredentialLease } from "./auth/contracts.js";
interface GrokProfileConfig {
  id: string;
  name: string;
  command: string;
  accountHome: string;
  credentialSocket?: string;
  deployment?: "local" | "container" | "remote";
}
/** Only this operator configuration can grant executables and account sources, never browser or document input. */
export function harnessProfiles(
  stateRoot: string,
  driver: EngineDriver,
  env: NodeJS.ProcessEnv = process.env,
): HarnessProfile[] {
  const profiles: HarnessProfile[] = [
    {
      id: "codex",
      name: "Codex",
      kind: "codex",
      deployment: "local",
      factory: { create: async () => new CodexHarnessAgent(driver) },
    },
  ];
  let grok: GrokProfileConfig[] = [];
  if (env.PANDA_FORCE_HARNESS_PROFILES) {
    try {
      const value: unknown = JSON.parse(env.PANDA_FORCE_HARNESS_PROFILES);
      if (!Array.isArray(value) || value.length > 32) throw Error();
      grok = value as GrokProfileConfig[];
    } catch {
      throw new HarnessError("invalidInput");
    }
  } else if (existsSync(env.PANDA_FORCE_GROK_COMMAND || "/usr/local/bin/grok")) {
    grok = [
      {
        id: "grok-build",
        name: "Grok Build",
        command: env.PANDA_FORCE_GROK_COMMAND || "/usr/local/bin/grok",
        accountHome: env.PANDA_FORCE_GROK_HOME || join(homedir(), ".grok"),
        ...(env.PANDA_FORCE_GROK_AUTH_SOCKET ? { credentialSocket: env.PANDA_FORCE_GROK_AUTH_SOCKET } : {}),
      },
    ];
  }
  for (const profile of grok) {
    if (
      !isRecord(profile) ||
      typeof profile.id !== "string" ||
      typeof profile.name !== "string" ||
      typeof profile.command !== "string" ||
      typeof profile.accountHome !== "string" ||
      !isAbsolute(profile.command) ||
      !isAbsolute(profile.accountHome) ||
      (profile.credentialSocket !== undefined &&
        (typeof profile.credentialSocket !== "string" ||
          !isAbsolute(profile.credentialSocket) ||
          Buffer.byteLength(profile.credentialSocket) > 100)) ||
      (profile.deployment !== undefined && !["local", "container", "remote"].includes(profile.deployment))
    )
      throw new HarnessError("invalidInput");
    profiles.push({
      id: profile.id,
      name: profile.name,
      kind: "grok-build",
      deployment: profile.deployment ?? "local",
      factory: {
        create: async (runtime, scope) => {
          const namespace = createHash("sha256")
            .update(`${runtime.id}\0${scope.owner}\0${scope.scopeId}`)
            .digest("hex");
          const home = resolve(stateRoot, "harness", "native", namespace);
          await mkdir(home, { recursive: true, mode: 0o700 });
          if ((await realpath(home)) !== home) throw new HarnessError("forbidden", 403);
          await chmod(home, 0o700);
          const privateWrite = async (name: string, value: string) => {
            const temporary = join(home, ".credential-" + randomUUID());
            const file = await open(
              temporary,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              try {
                await file.chmod(0o600);
                await file.writeFile(value);
                await file.sync();
              } finally {
                await file.close();
              }
              await rename(temporary, join(home, name));
            } finally {
              await unlink(temporary).catch(() => {});
            }
          };
          if (!profile.credentialSocket) {
            // Legacy operator-owned snapshots stay supported without granting refresh capability to an agent.
            try {
              const credentials: unknown = JSON.parse(await readFile(join(profile.accountHome, "auth.json"), "utf8"));
              await privateWrite("auth.json", JSON.stringify(accessCredentials(credentials)));
            } catch {
              throw new HarnessError("authentication", 503);
            }
          }
          await privateWrite(
            "config.toml",
            "[cli]\nauto_update = false\nuse_leader = false\n[features]\nshared_daemon = false\n",
          );
          if (scope.application) {
            // Scoped applications may discover only their leased MCP endpoint, including after project config merges.
            await privateWrite(
              "requirements.toml",
              [
                `allowed_mcp_servers = [{ server_url = ${JSON.stringify(scope.application.mcpServer.url)} }]`,
                "enable_all_project_mcp_servers = false",
                "plugin_auto_update = false",
                "allow_managed_hooks_only = true",
                "[managed_mcps]",
                "enabled = false",
                "gateway_tools_enabled = false",
                ...["claude", "cursor", "codex"].flatMap((name) => [
                  `[compat.${name}]`,
                  "hooks = false",
                  "skills = false",
                  ...(name === "codex" ? [] : ["agents = false", "mcps = false", "rules = false"]),
                ]),
                "[features]",
                "backend_tools = false",
                "image_gen = false",
                "video_gen = false",
                "feedback = false",
                "codebase_indexing = false",
              ].join("\n") + "\n",
            );
          }
          const nativeEnv: NodeJS.ProcessEnv = {};
          for (const name of [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "NODE_PATH",
            "PANDA_FORCE_CREATIVE_HOME",
            "PLAYWRIGHT_BROWSERS_PATH",
          ])
            if (env[name]) nativeEnv[name] = env[name];
          nativeEnv.GROK_HOME = home;
          nativeEnv.GROK_DISABLE_AUTOUPDATER = "1";
          nativeEnv.GROK_SHARED_DAEMON = "false";
          // Unix socket paths have a small OS limit; the durable account directory can be arbitrarily deep.
          const socketDirectory = await mkdtemp(join(tmpdir(), "pf-grok-"));
          let credentials: HarnessCredentialLease | undefined;
          try {
            if (profile.credentialSocket)
              credentials = await credentialLease(
                brokerCredentialSource(profile.credentialSocket),
                async (snapshot) => {
                  const principalFile = join(home, "credential-principal.json");
                  try {
                    if (JSON.parse(await readFile(principalFile, "utf8")) !== snapshot.principal)
                      throw new HarnessError("authentication", 503);
                  } catch (error) {
                    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
                      throw error;
                    await privateWrite("credential-principal.json", JSON.stringify(snapshot.principal));
                  }
                  await privateWrite("auth.json", JSON.stringify(snapshot.credentials));
                },
              );
            return new GrokHarnessAgent({
              command: profile.command,
              args: [
                "--no-auto-update",
                "--no-subagents",
                "--leader-socket",
                join(socketDirectory, "leader.sock"),
                "agent",
                "stdio",
              ],
              cwd: scope.cwd,
              env: nativeEnv,
              application: scope.application,
              ...(credentials ? { credentials } : {}),
              cleanup: async () => {
                await credentials?.close();
                await unlink(join(home, "auth.json")).catch(() => {});
                await rm(socketDirectory, { recursive: true, force: true });
                if (scope.application || scope.scopeId.startsWith("catalog-"))
                  await rm(home, { recursive: true, force: true });
              },
            });
          } catch (error) {
            await credentials?.close();
            await unlink(join(home, "auth.json")).catch(() => {});
            await rm(socketDirectory, { recursive: true, force: true });
            throw error;
          }
        },
      },
    });
  }
  return profiles;
}
