import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDriver } from "../../src/shared/engine/contracts.js";
import { applicationRuntimes } from "../../src/server/harness/application.js";
import { remoteAcpEndpoint } from "../../src/server/harness/auth/remote-acp.js";
import { harnessCreationCapabilities } from "../../src/server/harness/creation-capabilities.js";
import { harnessProfiles } from "../../src/server/harness/profiles.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { creationEngines } from "../../src/server/creation/integration/engines.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";

const acceptedWorkspace = "/provider/workspace";
const configuredKey = "remote-harness-fixture-key";
const models = [
  { value: "remote-default", name: "Remote default" },
  { value: "remote-selected", name: "Remote selected" },
];

interface Session {
  model: string;
  effort: string;
  scopedTools: boolean;
  mcpServerId?: string;
  promptId?: number;
}

test("a named remote ACP Harness uses TLS and the selected model with a scoped creation tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-remote-acp-"));
  const metadata = new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
  let closeServer: (() => void) | undefined;
  try {
    const certFile = join(root, "certificate.pem"),
      privateKeyFile = join(root, "private-key.pem");
    const certificate = Bun.spawnSync([
      "openssl",
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-x509",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      privateKeyFile,
      "-out",
      certFile,
    ]);
    if (certificate.exitCode !== 0) throw new Error("Could not create isolated TLS fixture");
    const apiKeyFile = join(root, "harness-api-key");
    await writeFile(apiKeyFile, configuredKey, { mode: 0o600 });
    const connections: string[] = [];
    const frames: string[] = [];
    let redirectTargetHits = 0,
      calls = 0;
    const server = Bun.serve<Session>({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: await readFile(certFile), key: await readFile(privateKeyFile) },
      fetch(request, server) {
        const { pathname } = new URL(request.url);
        if (pathname === "/redirected") redirectTargetHits++;
        connections.push(pathname);
        if (request.headers.get("authorization") !== "Bearer " + configuredKey)
          return new Response("Rejected private request", { status: 401 });
        if (pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/redirected" } });
        if (pathname !== "/acp" && pathname !== "/without-acp-tools") return new Response(null, { status: 404 });
        if (
          server.upgrade(request, {
            data: { model: "remote-default", effort: "low", scopedTools: pathname === "/acp" },
          })
        )
          return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        message(socket, frame) {
          const serialized = frame.toString();
          frames.push(serialized);
          const input = JSON.parse(serialized),
            data = socket.data;
          const send = (value: object) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...value }));
          const reply = (result: object) => send({ id: input.id, result });
          const options = () => [
            { id: "model", currentValue: data.model, options: models },
            { id: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
            {
              id: "effort",
              currentValue: data.effort,
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ];
          if (input.method === "initialize") {
            // Whitespace in a WebSocket message does not introduce another JSON-RPC frame.
            socket.send(
              JSON.stringify(
                {
                  jsonrpc: "2.0",
                  id: input.id,
                  result: {
                    protocolVersion: 1,
                    agentCapabilities: {
                      auth: { status: true },
                      promptCapabilities: { embeddedContext: true },
                      mcpCapabilities: { acp: data.scopedTools, http: true },
                    },
                  },
                },
                null,
                2,
              ),
            );
          } else if (input.method === "auth/status") reply({ state: "authenticated" });
          else if (input.method === "session/new") {
            expect(input.params.cwd).toBe(acceptedWorkspace);
            const [mcp] = input.params.mcpServers;
            if (mcp) {
              expect(mcp).toEqual({ type: "acp", name: "panda", serverId: expect.any(String) });
              data.mcpServerId = mcp.serverId;
              expect(input.params._meta.claudeCode.options.tools).toEqual([]);
            }
            reply({ sessionId: "remote-session", configOptions: options() });
          } else if (input.method === "session/set_config_option") {
            if (input.params.configId === "model") data.model = input.params.value;
            if (input.params.configId === "effort") data.effort = input.params.value;
            reply({ configOptions: options() });
          } else if (input.method === "session/prompt") {
            expect(data.model).toBe("remote-selected");
            expect(data.effort).toBe("high");
            data.promptId = input.id;
            send({
              id: "foreign-tool",
              method: "mcp/message",
              params: {
                serverId: "another-session",
                requestId: "foreign-job",
                method: "tools/call",
                params: { name: "panda_images_render", arguments: {} },
              },
            });
          } else if (input.id === "foreign-tool") {
            expect(input.error.code).toBe(-32603);
            send({
              id: "render",
              method: "mcp/message",
              params: {
                serverId: data.mcpServerId,
                requestId: "media-job",
                method: "tools/call",
                params: { name: "panda_images_render", arguments: { prompt: "An ancient city" } },
              },
            });
          } else if (input.id === "render") {
            expect(input.result).toMatchObject({ result: { resultType: "complete", isError: false } });
            send({ id: data.promptId, result: { stopReason: "end_turn" } });
          }
        },
      },
    });
    closeServer = () => server.stop(true);
    const base = "https://127.0.0.1:" + server.port;
    const config = {
      id: "scoped-remote",
      name: "Remote Claude Code",
      deployment: "remote",
      baseUrl: base + "/acp",
      remoteWorkspace: acceptedWorkspace,
      apiKeyFile,
      certificateAuthorityFile: certFile,
    };
    const driver = {} as EngineDriver;
    const installed = (profile: Record<string, unknown>) =>
      harnessProfiles(root, driver, {
        PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES: JSON.stringify([profile]),
        PANDA_FORCE_APP_SERVER_MODE: "isolated",
      }).find(({ id }) => id === "scoped-remote")!;
    const profile = installed(config);
    const registry = new HarnessRegistry(metadata, [profile]);
    await registry.initialize();
    const principal = { owner: "admin", administrator: true };
    expect((await registry.probe(principal, profile.id, root)).runtimes[0]?.models).toHaveLength(2);
    const port = applicationRuntimes({
      registry,
      scratchRoot: join(root, "scratch"),
      principal: async (owner) => ({ owner, administrator: owner === "admin" }),
      codex: () => {
        throw new Error("Unexpected fallback");
      },
    });
    const runtime = await port.discover("admin", profile.id, "creation");
    expect(runtime).toMatchObject({ deployment: "remote", status: "ready", protocol: "acp/1" });
    expect(runtime.capabilities?.fileInput).toBe(false);
    expect(runtime.models.map(({ id }) => id)).toEqual(models.map(({ value }) => value));
    expect(await harnessCreationCapabilities(runtime)).toMatchObject({
      applicationTools: true,
      nativeImageStatus: "unsupported",
    });
    expect((await port.catalog("member", "creation")).runtimes).toHaveLength(0);
    const selection = { runtimeId: profile.id, model: "remote-selected", effort: "high" };
    expect(await port.resolve("admin", selection, "creation")).toEqual(selection);
    const engines = creationEngines({
      connection: { mode: "isolated" },
      scratchRoot: root,
      version: "1",
      engineId: "codex",
      runtimes: port,
    });
    const result = await engines
      .select({ ...selection, id: profile.id, engineId: "harness-" + profile.id }, "admin")
      .run(
        {
          prompt: "Make a brief.",
          instructions: "Use scoped creation tools.",
          tools: [{ name: "panda_images_render", description: "Render an image", inputSchema: { type: "object" } }],
        },
        {
          signal: AbortSignal.timeout(10000),
          started() {},
          async call(value) {
            calls++;
            expect(value).toMatchObject({
              callId: "media-job",
              name: "panda_images_render",
              arguments: { prompt: "An ancient city" },
            });
            return { success: true, text: "An owned creation image handle" };
          },
        },
      );
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(frames.join("")).not.toContain(root);
    expect(frames.join("")).not.toContain("http://127.0.0.1");
    expect(frames.join("")).not.toContain(configuredKey);

    const open = (changes: Record<string, unknown>) =>
      installed({ ...config, ...changes }).factory.create(runtime, {
        owner: "admin",
        scopeId: "test-transport",
        cwd: root,
      });
    for (const [changes, code] of [
      [{ certificateAuthorityFile: undefined }, "unavailable"],
      [{ baseUrl: base + "/redirect" }, "unavailable"],
    ] as const) {
      const agent = await open(changes);
      try {
        await expect(agent.initialize()).rejects.toMatchObject({ code, dispatched: false });
      } finally {
        await agent.close();
      }
    }
    expect(redirectTargetHits).toBe(0);
    const missingTools = await open({ baseUrl: base + "/without-acp-tools" });
    try {
      await expect(missingTools.initialize()).rejects.toMatchObject({ code: "capabilityUnavailable" });
    } finally {
      await missingTools.close();
    }
    await writeFile(apiKeyFile, "rejected-credential");
    const rejected = await open({});
    try {
      await expect(rejected.initialize()).rejects.toMatchObject({ code: "authentication", dispatched: false });
    } finally {
      await rejected.close();
    }
    const connectionCount = connections.length;
    await chmod(apiKeyFile, 0o644);
    await expect(open({})).rejects.toMatchObject({ code: "authentication" });
    expect(connections).toHaveLength(connectionCount);
  } finally {
    closeServer?.();
    await metadata.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("remote ACP profiles reject bearer credentials in URLs and insecure destinations", () => {
  for (const input of [
    "http://provider.example/acp",
    "wss://user:key@provider.example/acp",
    "https://provider.example/?secret=1",
    "https://provider.example/#token",
  ])
    expect(() => remoteAcpEndpoint(input)).toThrow("invalidInput");
  expect(remoteAcpEndpoint("https://provider.example/service/acp").href).toBe("wss://provider.example/service/acp");
});
