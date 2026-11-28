import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "../../../shared/harness/contracts.js";
import type { ApplicationImageRenderer } from "../../engines/application-tools/runtime-port.js";
import { captureNativeProcess, nativeProcessLaunchSocket, nativeProcessScratch } from "../../engines/native-process.js";
import { brokerCredentialSource, credentialLease } from "../auth/remote.js";
import { accessCredentials } from "../auth/snapshot.js";
import type { HarnessCredentialLease } from "../auth/contracts.js";
import { acpRecord, acpText } from "./acp.js";
import { HarnessStdioTransport } from "./stdio.js";

const generationProfile = {
  name: "panda-imagine",
  description: "Native Grok image generation",
  promptMode: "full",
  promptBody: "Use only the native image_gen tool. Produce exactly one raster image at the requested aspect ratio.",
  injectDefaultTools: false,
  agentsMd: false,
  discoverSkills: false,
  inheritSkills: false,
  toolConfig: { tools: [{ id: "GrokBuild:image_gen" }] },
};
const config = "[cli]\nauto_update = false\nuse_leader = false\n[features]\nshared_daemon = false\n";
const requirements = [
  "enable_all_project_mcp_servers = false",
  "allow_managed_hooks_only = true",
  "[managed_mcps]",
  "enabled = false",
  "gateway_tools_enabled = false",
  "[features]",
  "backend_tools = false",
  "video_gen = false",
  "feedback = false",
  "codebase_indexing = false",
  "",
].join("\n");
const imageLimit = 32 * 1024 * 1024;
const execute = promisify(execFile);

async function readGeneratedImage(home: string) {
  const images = (await readdir(home, { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.(?:jpe?g|png|webp)$/i.test(entry.name) && entry.parentPath.endsWith("/images"),
  );
  if (images.length !== 1) throw new HarnessError("capabilityUnavailable", 409);
  const path = join(images[0]!.parentPath, images[0]!.name);
  if (!path.startsWith(home + "/") || (await realpath(path)) !== path)
    throw new HarnessError("workspaceUnavailable", 409);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > imageLimit) throw new HarnessError("invalidProtocol", 503);
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new HarnessError("invalidProtocol", 503);
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/** Run only Imagine in a new native session using the installed Grok account. */
export function grokImageRenderer(
  profile: { command: string; accountHome: string; credentialSocket?: string },
  environment: NodeJS.ProcessEnv,
): ApplicationImageRenderer {
  return {
    provider: "grok-build",
    maxReferences: 0,
    maxReferenceBytes: 0,
    async version() {
      const args = ["--no-auto-update", "--version"],
        env = { PATH: environment.PATH, GROK_DISABLE_AUTOUPDATER: "1" },
        relay = nativeProcessLaunchSocket();
      const stdout = relay
        ? (
            await captureNativeProcess(
              relay,
              { command: profile.command, args, env, cwd: await nativeProcessScratch() },
              Buffer.alloc(0),
              2048,
              AbortSignal.timeout(3500),
            )
          ).toString("utf8")
        : (await execute(profile.command, args, { env, timeout: 3500, maxBuffer: 2048 })).stdout;
      const version = /^grok (\d+\.\d+\.\d+)(?: \([a-f0-9]+\))?$/i.exec(stdout.trim())?.[1];
      if (!version) throw new HarnessError("invalidProtocol", 503);
      return version;
    },
    async render(prompt, references, signal) {
      if (references.length) throw new HarnessError("invalidInput");
      const execution = AbortSignal.any([signal, AbortSignal.timeout(360_000)]);
      execution.throwIfAborted();
      const root = await realpath(await mkdtemp(join(await nativeProcessScratch(), "pf-grok-image-")));
      const home = join(root, "home"),
        cwd = join(root, "workspace");
      let lease: HarnessCredentialLease | undefined, transport: HarnessStdioTransport | undefined;
      let closing: Promise<void> | undefined;
      const closeTransport = () => (transport ? (closing ??= transport.close()) : Promise.resolve());
      const abort = () => {
        void closeTransport().catch(() => {});
      };
      execution.addEventListener("abort", abort, { once: true });
      try {
        await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
        const auth = join(home, "auth.json");
        const install = async (value: unknown) => {
          const temporary = join(home, ".auth.next");
          await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
          await rename(temporary, auth);
        };
        if (profile.credentialSocket) {
          lease = await credentialLease(brokerCredentialSource(profile.credentialSocket), (snapshot) =>
            install(snapshot.credentials),
          );
        } else {
          const credentials: unknown = JSON.parse(await readFile(join(profile.accountHome, "auth.json"), "utf8"));
          await install(accessCredentials(credentials));
        }
        await Promise.all([
          writeFile(join(home, "config.toml"), config, { mode: 0o600 }),
          writeFile(join(home, "requirements.toml"), requirements, { mode: 0o600 }),
        ]);
        execution.throwIfAborted();
        const env: NodeJS.ProcessEnv = {};
        for (const name of [
          "PATH",
          "HOME",
          "LANG",
          "LC_ALL",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "NO_PROXY",
        ])
          if (environment[name]) env[name] = environment[name];
        let sessionId = "";
        const completed = new Set<string>();
        transport = new HarnessStdioTransport({
          command: profile.command,
          args: ["--no-auto-update", "--no-subagents", "--leader-socket", join(root, "l.sock"), "agent", "stdio"],
          cwd,
          env: { ...env, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1", GROK_SHARED_DAEMON: "false" },
          async onRequest(method) {
            if (method !== "session/request_permission") throw new HarnessError("capabilityUnavailable", 409);
            return { outcome: { outcome: "cancelled" } };
          },
          onNotification(method, params) {
            if (method !== "session/update" || params.sessionId !== sessionId) return;
            const update = acpRecord(params.update);
            if (update.sessionUpdate !== "tool_call_update" || update.status !== "completed") return;
            const id = acpText(update.toolCallId);
            if (/^[a-z\d_-]{1,160}$/i.test(id)) completed.add(id);
          },
        });
        const info = acpRecord(
          await transport.request("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "pandaforce", version: "1" },
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          }),
        );
        if (info.protocolVersion !== 1) throw new HarnessError("invalidProtocol", 503);
        if (
          Array.isArray(info.authMethods) &&
          info.authMethods.some((method) => acpRecord(method).id === "cached_token")
        )
          await transport.request("authenticate", { methodId: "cached_token", _meta: { headless: true } });
        const session = acpRecord(
          await transport.request("session/new", {
            cwd,
            mcpServers: [],
            _meta: { yoloMode: true, autoMode: false, agentProfile: generationProfile },
          }),
        );
        sessionId = acpText(session.sessionId);
        if (!sessionId) throw new HarnessError("invalidProtocol", 503);
        execution.throwIfAborted();
        const result = acpRecord(
          await transport.request(
            "session/prompt",
            {
              sessionId,
              prompt: [{ type: "text", text: "/imagine " + prompt }],
            },
            null,
          ),
        );
        execution.throwIfAborted();
        if (result.stopReason !== "end_turn" || completed.size !== 1)
          throw new HarnessError("capabilityUnavailable", 409);
        await closeTransport();
        execution.throwIfAborted();
        return { bytes: await readGeneratedImage(home), invocationId: [...completed][0] };
      } finally {
        execution.removeEventListener("abort", abort);
        await closeTransport().catch(() => {});
        await lease?.close().catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
