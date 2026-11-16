import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { CliProfiles } from "../../src/cli/profiles.js";
import { cliApiRoute } from "../../src/server/cli/integration/http.js";
import { createRouter } from "../../src/server/http/router.js";
import { createCodexBridge } from "../../src/server/bridge/codex-process.js";
const evidence = resolve(process.env.PANDA_FORCE_CLI_AGENT_EVIDENCE_DIR || ".artifacts/cli-native-agent-clients");
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "panda-agent-probe-")),
  home = await mkdtemp(join(evidence, "home-"));
await mkdir(join(home, ".codex"));
await mkdir(join(root, "work"));
const binary = join(evidence, "panda.mjs"),
  profilesRoot = join(root, "profiles");
const built = await Bun.build({ entrypoints: ["src/cli/main.ts"], target: "node" });
assert.equal(built.success, true);
await Bun.write(binary, await built.outputs[0].text());
const database = openCliCredentialStore(":memory:"),
  credentials = new CliCredentials(database.store),
  profiles = new CliProfiles(profilesRoot),
  calls = [];
const route = cliApiRoute(credentials, {
    execute: async (owner, id, args) => {
      calls.push({ owner, id, args });
      return { documents: [] };
    },
  }),
  dispatch = createRouter([route]);
const http = createServer((req, res) => {
  void dispatch({ req, res, url: new URL(req.url, "http://" + req.headers.host) });
});
http.keepAliveTimeout = 0;
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + http.address().port;
const providerRequests = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    providerRequests.push({ method: request.method, path: new URL(request.url).pathname });
    return new Response("No model calls allowed", { status: 400 });
  },
});
const environment = {
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  PANDA_CLI_HOME: profilesRoot,
  ANTHROPIC_API_KEY: "synthetic-not-valid",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
};
let child,
  control,
  stopping = false;
async function command(binary, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { cwd: join(root, "work"), env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", (b) => (output += b));
    proc.stderr.on("data", (b) => (output += b));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error("Native client command failed " + code + ": " + output.slice(-1500)));
      else resolve(output);
    });
  });
}
async function until(check) {
  const end = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() > end) throw Error("Native client observation timed out");
    await Bun.sleep(25);
  }
}
try {
  for (const kind of ["codex", "claude"]) {
    const issued = await credentials.issue(
      "synthetic-owner",
      base,
      {
        name: kind,
        kind,
        projects: ["personal"],
        capabilities: ["content:read", "search:read", "knowledge:records:read"],
        expiresInDays: 1,
      },
      async () => {},
    );
    await profiles.register(kind, issued.registration);
    await profiles.login(kind, issued.apiKey);
  }
  await command("claude", [
    "mcp",
    "add",
    "--scope",
    "user",
    "panda",
    "--",
    "node",
    binary,
    "mcp",
    "serve",
    "--profile",
    "claude",
  ]);
  const claude = await command("claude", ["mcp", "list"]);
  assert.match(claude, /Connected/i);
  await writeFile(join(evidence, "claude-health.txt"), claude);
  console.log("Claude MCP health connected");
  const socket = join(root, "app.sock"),
    config = {
      model_provider: "local_fixture",
      model: "local-fixture",
      "model_providers.local_fixture.name": "Local MCP fixture",
      "model_providers.local_fixture.base_url": `http://127.0.0.1:${provider.port}`,
      "model_providers.local_fixture.wire_api": "responses",
      "model_providers.local_fixture.requires_openai_auth": false,
      "mcp_servers.panda.command": "node",
      "mcp_servers.panda.args": [binary, "mcp", "serve", "--profile", "codex"],
      "mcp_servers.panda.env.PANDA_CLI_HOME": profilesRoot,
    };
  const args = ["app-server", "--listen", "unix://" + socket];
  for (const [key, value] of Object.entries(config)) args.push("-c", key + "=" + JSON.stringify(value));
  child = spawn("codex", args, {
    cwd: join(root, "work"),
    env: environment,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-6000)));
  await until(async () => {
    if (child.exitCode !== null) throw Error("Native Codex exited: " + stderr);
    try {
      return (await stat(socket)).isSocket();
    } catch {
      return false;
    }
  });
  control = createCodexBridge({
    connection: { mode: "shared", socketPath: socket },
    defaultCwd: join(root, "work"),
    clientInfo: { name: "panda-mcp-probe", title: "MCP probe", version: "test" },
    isShuttingDown: () => stopping,
    onConnected() {},
    onDisconnected() {},
    onMessage() {},
  });
  await control.request("thread/start", {
    cwd: join(root, "work"),
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  let status;
  await until(async () => {
    status = await control.request("mcpServerStatus/list", { limit: 100 });
    return status.data.some((x) => x.name === "panda" && Object.keys(x.tools || {}).length);
  });
  const panda = status.data.find((x) => x.name === "panda");
  assert.ok(Object.keys(panda.tools).some((name) => name.includes("panda_documents_read")));
  assert.ok(Object.keys(panda.tools).some((name) => name.includes("panda_knowledge_records_read")));
  assert.ok(Object.keys(panda.tools).some((name) => name.includes("panda_search_status")));
  await writeFile(
    join(evidence, "codex-status.json"),
    JSON.stringify(
      { data: [{ name: panda.name, tools: Object.keys(panda.tools), authStatus: panda.authStatus }] },
      null,
      2,
    ),
  );
  await profiles.logout("claude");
  const withoutKey = await command("claude", ["mcp", "list"]);
  assert.match(withoutKey, /Failed|Error|Disconnected/i);
  assert.ok(!withoutKey.includes("✔ Connected"));
  await writeFile(join(evidence, "claude-no-key.txt"), withoutKey);
  const inference = providerRequests.filter(
    (x) => x.method === "POST" && /(?:\/responses|\/messages|\/chat\/completions)$/.test(x.path),
  );
  assert.equal(inference.length, 0, JSON.stringify(providerRequests));
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        claudeConnected: true,
        claudeWithoutKeyDenied: true,
        codexToolsAvailable: true,
        inferenceCalls: inference.length,
        providerMetadataRequests: providerRequests,
        sharedHomeChanged: false,
      },
      null,
      2,
    ),
  );
  console.log("Codex native MCP discovery connected; no model calls");
} finally {
  stopping = true;
  control?.cancelRestart();
  control?.terminate("Fixture complete");
  if (child && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await new Promise((r) => http.close(r));
  provider.stop(true);
  database.close();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
