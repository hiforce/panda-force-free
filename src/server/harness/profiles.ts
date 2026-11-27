import { allowsHarnessOutputWrite } from "./workspaces.js";
import { acpRecord } from "./adapters/acp.js";
import { createCodexApplicationEngine } from "../engines/application-tools/codex.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, constants } from "node:fs";
import { chmod, mkdir, readFile, open, realpath, mkdtemp, rm, unlink, rename, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { HARNESS_PERMISSION_MODES, HarnessError, type HarnessPermissionMode } from "../../shared/harness/contracts.js";
import { isRecord } from "../../shared/records.js";
import type { EngineDriver } from "../../shared/engine/contracts.js";
import type { HarnessProfile } from "./registry.js";
import { CodexHarnessAgent } from "./adapters/codex.js";
import { GrokHarnessAgent } from "./adapters/grok.js";
import { accessCredentials } from "./auth/snapshot.js";
import { brokerCredentialSource, credentialLease } from "./auth/remote.js";
import type { HarnessCredentialLease } from "./auth/contracts.js";
import { createCodexDriver } from "../engines/codex.js";
import { ZCodeHarnessAgent } from "./adapters/zcode.js";
import { AntigravityHarnessAgent, antigravityApplicationAgent } from "./adapters/antigravity.js";
import { AcpSessionAgent } from "./adapters/acp-session.js";
import { managedCodexFactory } from "./codex-profile.js";
import { resolveAppServerConnection } from "../bridge/app-server-connection.js";

function profileEntries(value: string | undefined): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const entries: unknown = JSON.parse(value);
    if (Array.isArray(entries) && entries.length <= 32 && entries.every(isRecord)) return entries;
  } catch {}
  throw new HarnessError("invalidInput");
}

function profileIdentity(profile: Record<string, unknown>) {
  if (
    typeof profile.id !== "string" ||
    typeof profile.name !== "string" ||
    !profile.name.trim() ||
    profile.name.length > 80
  )
    throw new HarnessError("invalidInput");
  return { id: profile.id, name: profile.name.trim() };
}

function operatorPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new HarnessError("invalidInput");
  return value;
}

function operatorSocketPath(value: unknown) {
  const path = operatorPath(value);
  if (Buffer.byteLength(path) > 100) throw new HarnessError("invalidInput");
  return path;
}

function codexSocketFactory(
  socketPath: string,
  sharedSocket: string | undefined,
  managed: HarnessProfile["factory"],
): HarnessProfile["factory"] {
  return {
    create: async (runtime, scope) => {
      const { cwd, persistentConversation } = scope;
      if (persistentConversation && sharedSocket) {
        const [selected, shared] = await Promise.all([stat(socketPath), stat(sharedSocket)]);
        if (selected.dev === shared.dev && selected.ino === shared.ino) return managed.create(runtime, scope);
      }
      let shuttingDown = false;
      const isolated = createCodexDriver({
        connection: { mode: "shared", socketPath },
        defaultCwd: cwd,
        version: "1",
        isShuttingDown: () => shuttingDown,
      });
      return new CodexHarnessAgent(
        isolated,
        () => {
          shuttingDown = true;
          isolated.cancelRestart();
          isolated.stop();
        },
        persistentConversation,
      );
    },
  };
}

function codexSocketApplication(socketPath: string): NonNullable<HarnessProfile["applicationEngine"]> {
  return (selection, directory, purpose) =>
    createCodexApplicationEngine({
      connection: { mode: "shared", socketPath },
      scratchDirectory: directory,
      version: "1",
      model: selection.model,
      effort: selection.effort,
      purpose,
    });
}

function zcodeSelection(profile: Record<string, unknown>) {
  const { providerId, model, efforts, defaultEffort } = profile;
  if (typeof providerId !== "string" || !providerId.trim() || typeof model !== "string" || !model.trim())
    throw new HarnessError("invalidInput");
  if (
    (efforts !== undefined &&
      (!Array.isArray(efforts) ||
        efforts.length > 16 ||
        !efforts.every((value) => typeof value === "string" && value.trim()))) ||
    (defaultEffort !== undefined &&
      (typeof defaultEffort !== "string" || !Array.isArray(efforts) || !efforts.includes(defaultEffort)))
  )
    throw new HarnessError("invalidInput");
  return { providerId, model, efforts, defaultEffort };
}

const claudeNativeModes = {
  ask: "default",
  "accept-edits": "acceptEdits",
  plan: "plan",
  "always-approve": "auto",
  "deny-unapproved": "dontAsk",
  "full-access": "bypassPermissions",
} as const satisfies Record<HarnessPermissionMode, string>;

function claudeAgent(
  connection: ConstructorParameters<typeof AcpSessionAgent>[0],
  application?: ConstructorParameters<typeof AcpSessionAgent>[1]["application"],
) {
  return new AcpSessionAgent(connection, {
    args: [],
    effortId: "effort",
    permissionMode: "ask",
    permissionModes: [...HARNESS_PERMISSION_MODES],
    nativeModes: claudeNativeModes,
    checkAuthStatus: true,
    application,
    ...(application
      ? {
          allowApplicationTool: (tool: Record<string, unknown>) =>
            !!application.nativeOutput &&
            tool.name === "Write" &&
            tool.kind === "edit" &&
            allowsHarnessOutputWrite(connection.cwd, acpRecord(tool.rawInput).file_path),
          applicationMeta: {
            systemPrompt: application.instructions,
            claudeCode: {
              options: {
                tools: application.nativeOutput ? ["Write"] : [],
                settingSources: [],
                strictMcpConfig: true,
                allowDangerouslySkipPermissions: false,
                allowedTools: (application.toolNames ?? []).map(
                  (name) => `mcp__${application.mcpServer.name}__${name}`,
                ),
              },
            },
          },
        }
      : {}),
  });
}

function runtimeHome(stateRoot: string, ...scope: string[]) {
  return resolve(stateRoot, "harness", "native", createHash("sha256").update(scope.join("\0")).digest("hex"));
}
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
  const managedCodex = managedCodexFactory(stateRoot, driver, env);
  const connection = resolveAppServerConnection(env, env.HOME || homedir());
  const sharedSocket = connection.mode === "shared" ? connection.socketPath : undefined;
  const profiles: HarnessProfile[] = [
    {
      id: "codex",
      name: "Codex",
      kind: "codex",
      deployment: "local",
      applicationScopes: ["project-memory"],
      factory: managedCodex,
    },
  ];
  for (const profile of profileEntries(env.PANDA_FORCE_CODEX_HARNESS_PROFILES)) {
    const socketPath = operatorSocketPath(profile.socketPath);
    profiles.push({
      ...profileIdentity(profile),
      kind: "codex",
      deployment: "local",
      conversationOnly: true,
      applicationScopes: ["bots", "creation", "project-memory"],
      applicationEngine: codexSocketApplication(socketPath),
      factory: codexSocketFactory(socketPath, sharedSocket, managedCodex),
    });
  }
  for (const profile of profileEntries(env.PANDA_FORCE_ZCODE_HARNESS_PROFILES)) {
    const identity = profileIdentity(profile),
      command = operatorPath(profile.command),
      builtinConfig = operatorPath(profile.builtinConfig),
      providerConfig = operatorPath(profile.providerConfig);
    const selection = zcodeSelection(profile);
    profiles.push({
      ...identity,
      kind: "zcode",
      deployment: "local",
      conversationOnly: true,
      applicationScopes: ["bots", "creation", "project-memory"],
      isolatedApplicationWorkspace: true,
      factory: {
        create: async (runtime, { owner, scopeId, cwd, application }) => {
          const home = runtimeHome(stateRoot, "zcode", runtime.id, owner, scopeId);
          await mkdir(home, { recursive: true, mode: 0o700 });
          if ((await realpath(home)) !== home) throw new HarnessError("forbidden", 403);
          await chmod(home, 0o700);
          const nativeEnv: NodeJS.ProcessEnv = {
            HOME: home,
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_DATA_HOME: join(home, "data"),
            XDG_CACHE_HOME: join(home, "cache"),
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
            ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfig,
          };
          for (const key of ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"])
            if (env[key]) nativeEnv[key] = env[key];
          return new ZCodeHarnessAgent({
            command,
            cwd,
            env: nativeEnv,
            ...selection,
            application,
            cleanup: async () => {
              if (application || /^(catalog|ping|probe)-/.test(scopeId))
                await rm(home, { recursive: true, force: true });
            },
          });
        },
      },
    });
  }
  for (const profile of profileEntries(env.PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES)) {
    const identity = profileIdentity(profile),
      command = operatorPath(profile.command ?? "/usr/local/bin/agy"),
      accountHome = resolve(operatorPath(profile.accountHome));
    const deployment = profile.deployment ?? "local";
    if (deployment !== "local" && deployment !== "container") throw new HarnessError("invalidInput");
    profiles.push({
      ...identity,
      kind: "antigravity",
      deployment,
      conversationOnly: true,
      applicationScopes: ["bots", "creation", "project-memory"],
      isolatedApplicationWorkspace: true,
      factory: {
        create: async (_runtime, { cwd, permissionMode, application }) => {
          if (accountHome === resolve(homedir())) throw new HarnessError("invalidInput");
          const nativeEnv: NodeJS.ProcessEnv = { HOME: accountHome };
          for (const key of [
            "PATH",
            "LANG",
            "LC_ALL",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
          ])
            if (env[key]) nativeEnv[key] = env[key];
          const launch = { command, cwd, env: nativeEnv };
          return application
            ? antigravityApplicationAgent(launch, application)
            : new AntigravityHarnessAgent(launch, permissionMode);
        },
      },
    });
  }
  for (const profile of profileEntries(env.PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES)) {
    const identity = profileIdentity(profile),
      command = operatorPath(profile.command),
      claudeCommand = operatorPath(profile.claudeCommand),
      accountHome = resolve(operatorPath(profile.accountHome));
    const deployment = profile.deployment ?? "local";
    if (deployment !== "local" && deployment !== "container") throw new HarnessError("invalidInput");
    profiles.push({
      ...identity,
      kind: "claude-code",
      deployment,
      conversationOnly: true,
      applicationScopes: ["bots", "creation", "project-memory"],
      isolatedApplicationWorkspace: true,
      factory: {
        create: async (_runtime, { cwd, application }) => {
          const account = await stat(accountHome).catch(() => null);
          if (!account) throw new HarnessError("unavailable", 503);
          if (
            !account.isDirectory() ||
            (account.mode & 0o077) !== 0 ||
            (process.getuid && account.uid !== process.getuid()) ||
            (await realpath(accountHome)) !== accountHome
          )
            throw new HarnessError("forbidden", 403);
          const nativeEnv: NodeJS.ProcessEnv = {
            HOME: accountHome,
            CLAUDE_CONFIG_DIR: join(accountHome, ".claude"),
            CLAUDE_CODE_EXECUTABLE: claudeCommand,
            CLAUDE_AGENT_ACP_PROTOCOL: "v1",
            DISABLE_AUTOUPDATER: "1",
          };
          for (const key of ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"])
            if (env[key]) nativeEnv[key] = env[key];
          return claudeAgent({ command, cwd, env: nativeEnv }, application);
        },
      },
    });
  }
  for (const profile of profileEntries(env.PANDA_FORCE_HOST_HARNESS_PROFILES)) {
    const { kind } = profile;
    const socketPath = operatorSocketPath(profile.socketPath);
    let factory: HarnessProfile["factory"];
    switch (kind) {
      case "codex":
        factory = codexSocketFactory(socketPath, sharedSocket, managedCodex);
        break;
      case "grok-build":
        factory = { create: async (_runtime, { cwd }) => new GrokHarnessAgent({ socketPath, cwd }) };
        break;
      case "antigravity":
        factory = {
          create: async (_runtime, { cwd, permissionMode }) =>
            new AntigravityHarnessAgent({ socketPath, cwd }, permissionMode),
        };
        break;
      case "claude-code":
        factory = { create: async (_runtime, { cwd, application }) => claudeAgent({ socketPath, cwd }, application) };
        break;
      case "zcode": {
        const selection = zcodeSelection(profile);
        factory = {
          create: async (_runtime, { cwd }) => new ZCodeHarnessAgent({ socketPath, cwd, ...selection }),
        };
        break;
      }
      default:
        throw new HarnessError("invalidInput");
    }
    profiles.push({
      ...profileIdentity(profile),
      kind,
      deployment: "local",
      conversationOnly: true,
      hostSocket: true,
      ...(kind === "codex"
        ? {
            applicationScopes: ["bots", "creation", "project-memory"],
            applicationEngine: codexSocketApplication(socketPath),
          }
        : {}),
      ...(kind === "claude-code"
        ? { applicationScopes: ["bots", "creation", "project-memory"], isolatedApplicationWorkspace: true }
        : {}),
      factory,
    });
  }
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
      applicationScopes: ["project-memory"],
      deployment: profile.deployment ?? "local",
      factory: {
        create: async (runtime, scope) => {
          const home = runtimeHome(stateRoot, runtime.id, scope.owner, scope.scopeId);
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
