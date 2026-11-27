import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { managedCodexFactory } from "../../src/server/harness/codex-profile.ts";

const root = await mkdtemp(join(tmpdir(), "panda-native-harness-"));
const source = join(root, "account");
const state = join(root, "panda");
const cwd = join(root, "project");
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return new Response(null, { status: 404 });
    await request.json();
    const id = "response-" + ++requests;
    const message = {
      id: "message-" + requests,
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Isolated native reply." }],
    };
    const body = [
      ["response.created", { response: { id, status: "in_progress", output: [] } }],
      ["response.output_item.done", { output_index: 0, item: message }],
      [
        "response.completed",
        {
          response: {
            id,
            status: "completed",
            output: [message],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ],
    ]
      .map(([type, payload]) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...payload }) + "\n\n")
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});
try {
  await Promise.all([mkdir(source), mkdir(state), mkdir(cwd)]);
  const auth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-only" });
  await writeFile(join(source, "auth.json"), auth, { mode: 0o600 });
  const configuration = [
    'model_provider = "mock"',
    'model = "mock"',
    `sqlite_home = ${JSON.stringify(source)}`,
    "[model_providers.mock]",
    'name = "Mock"',
    `base_url = "http://127.0.0.1:${provider.port}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
  ].join("\n");
  await writeFile(join(source, "config.toml"), configuration);
  const runtime = { id: "codex" };
  const scope = { owner: "first-owner", scopeId: randomUUID(), cwd, persistentConversation: true };
  const shared = { execute: () => assert.fail("Managed runs must leave the shared daemon untouched") };
  const environment = { ...process.env, CODEX_HOME: source };
  const run = async (agent, session, text) => {
    const reply = await agent.prompt(
      session,
      { text, model: null, effort: null, attachments: [], operationId: randomUUID() },
      async () => {},
    );
    assert.equal(reply.stopReason, "complete");
  };
  let thread;
  const first = await managedCodexFactory(state, shared, environment).create(runtime, scope);
  try {
    assert.equal((await first.initialize()).capabilities.load, true);
    thread = await first.create(cwd);
    await run(first, thread, "The project release color is green.");
  } finally {
    await first.close();
  }
  const nativeRoot = resolve(state, "harness/native/codex");
  const entries = await readdir(nativeRoot);
  assert.equal(entries.length, 1);
  await assert.rejects(access(join(nativeRoot, entries[0], "auth.json")), { code: "ENOENT" });
  const reopened = await managedCodexFactory(state, shared, environment).create(runtime, scope);
  try {
    const same = await reopened.load(thread.id, cwd);
    assert.equal(same.id, thread.id);
    await run(reopened, same, "Please continue with the saved release color.");
  } finally {
    await reopened.close();
  }
  const other = await managedCodexFactory(state, shared, environment).create(runtime, {
    ...scope,
    owner: "other-owner",
  });
  try {
    await assert.rejects(other.load(thread.id, cwd), { code: "notFound" });
  } finally {
    await other.close();
  }
  assert.equal(requests, 2);
  assert.equal(await readFile(join(source, "auth.json"), "utf8"), auth);
  assert.equal(await readFile(join(source, "config.toml"), "utf8"), configuration);
  await assert.rejects(access(join(source, "sessions")), { code: "ENOENT" });
  assert.deepEqual((await readdir(source)).sort(), ["auth.json", "config.toml"]);
  console.log("Real Codex resumed the same persistent thread from isolated state and kept shared history private.");
} finally {
  provider.stop(true);
  await rm(root, { recursive: true, force: true });
}
