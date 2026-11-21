import { harnessEditorialModels } from "../../src/server/editorial/integration/harness.js";
import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { harnessProfiles } from "../../src/server/harness/profiles.js";
import { applicationRuntimes } from "../../src/server/harness/application.js";
import { applicationMcp } from "../../src/server/harness/application-mcp.js";
import { changeRuntimeSelection, runtimeModelCatalog } from "../../src/shared/engine/runtime-selection.js";
import type { EngineDriver } from "../../src/shared/engine/contracts.js";
import type { HarnessRuntimeView } from "../../src/shared/harness/contracts.js";
import { CreationProfiles } from "../../src/server/creation/integration/profiles.js";
import { creationEngineProfile } from "../../src/server/creation/input-values.js";
import { BotStore } from "../../src/server/bots/store.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { BotChatWorker } from "../../src/server/bots/workspace/chat-worker.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { randomUUID } from "node:crypto";
import { ManualRunClock } from "../support/run-clock.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const work of cleanups.splice(0).reverse()) await work();
});
async function fixture(now?: () => number, runClock?: ManualRunClock) {
  const root = await mkdtemp(join(tmpdir(), "panda-runtime-app-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const account = join(root, "account");
  await mkdir(account);
  await writeFile(join(account, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
  const driver = {
    subscribe: () => () => {},
    execute: async () => ({
      data: [
        {
          id: "gpt-fixture",
          model: "gpt-fixture",
          displayName: "GPT fixture",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
        },
      ],
    }),
  } as unknown as EngineDriver;
  const metadata = new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
  cleanups.push(async () => metadata.close());
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(root, driver, {
      PATH: process.env.PATH,
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome: account,
        },
      ]),
    }),
  );
  await registry.initialize();
  const codexCalls: Array<{ model?: string; effort?: string; sessionId?: string }> = [];
  const port = applicationRuntimes({
    registry,
    now,
    runClock,
    scratchRoot: join(root, "scratch"),
    principal: async (owner) => ({ owner, administrator: owner === "alice" }),
    codex: (selection) => ({
      id: "codex",
      forget: async () => {},
      async run(input, callbacks) {
        codexCalls.push({ ...selection, sessionId: input.sessionId });
        const scope = { sessionId: randomUUID(), runId: randomUUID() };
        await callbacks.session?.(scope.sessionId);
        await callbacks.started(scope);
        await callbacks.call({
          ...scope,
          callId: "reply",
          name: "panda_bot_chat_reply",
          arguments: { text: "Native Codex answer" },
        });
        return { ...scope, status: "completed" };
      },
    }),
  });
  return { root, registry, port, codexCalls };
}
test("capability discovery coalesces cold reads, reuses success and rechecks access and configuration", async () => {
  const { registry, port } = await fixture();
  const agent = spyOn(registry, "agent");
  await Promise.all(Array.from({ length: 4 }, () => port.discover("alice", "grok-local")));
  expect(agent).toHaveBeenCalledTimes(1);
  await port.discover("alice", "grok-local");
  expect(agent).toHaveBeenCalledTimes(1);
  await expect(port.discover("bob", "grok-local")).rejects.toMatchObject({ code: "notFound" });
  const value = (await port.catalog("alice")).runtimes.find((runtime) => runtime.id === "grok-local")!;
  await registry.configure({ owner: "alice", administrator: true }, { ...value, name: "Updated runtime" });
  expect((await port.discover("alice", "grok-local")).name).toBe("Updated runtime");
  expect(agent).toHaveBeenCalledTimes(2);
  const current = (await port.catalog("alice")).runtimes.find((runtime) => runtime.id === "grok-local")!;
  await registry.configure({ owner: "alice", administrator: true }, { ...current, enabled: false });
  await expect(port.discover("alice", "grok-local")).rejects.toMatchObject({ code: "notFound" });
  expect(agent).toHaveBeenCalledTimes(2);
});
test("expired discovery is refreshed and failures remain retryable without retaining stale success", async () => {
  let now = 0;
  const { registry, port } = await fixture(() => now);
  const agent = spyOn(registry, "agent");
  await port.discover("alice", "grok-local");
  now = 300001;
  agent.mockRejectedValueOnce(new Error("Unavailable fixture"));
  await expect(port.discover("alice", "grok-local")).rejects.toThrow("Unavailable fixture");
  await port.discover("alice", "grok-local");
  expect(agent).toHaveBeenCalledTimes(3);
  await port.discover("alice", "grok-local");
  expect(agent).toHaveBeenCalledTimes(3);
});
test("disabling a runtime fences every joined discovery before its result is published", async () => {
  const { registry, port } = await fixture();
  const original = registry.agent.bind(registry);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const agent = spyOn(registry, "agent").mockImplementationOnce(async (...args) => {
    const opened = await original(...args),
      create = opened.agent.create.bind(opened.agent);
    opened.agent.create = async (...input) => {
      started();
      await held;
      return create(...input);
    };
    return opened;
  });
  const results = Promise.allSettled([port.discover("alice", "grok-local"), port.discover("alice", "grok-local")]);
  await opening;
  const current = (await port.catalog("alice")).runtimes.find((runtime) => runtime.id === "grok-local")!;
  await registry.configure({ owner: "alice", administrator: true }, { ...current, enabled: false });
  release();
  for (const result of await results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "notFound" });
  }
  expect(agent).toHaveBeenCalledTimes(1);
});
const replyTool = {
  name: "panda_bot_chat_reply",
  description: "Publish reply",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
test("runtime catalogs, defaults and model changes use one capability projection without cross-provider fallback", async () => {
  const { port, registry } = await fixture();
  const grok = await port.discover("alice", "grok-local");
  expect(runtimeModelCatalog(grok).data.map((m) => m.model)).toEqual(["grok-fixture"]);
  expect(await port.resolve("alice", { runtimeId: "grok-local" })).toEqual({
    runtimeId: "grok-local",
    model: "grok-fixture",
    effort: "high",
  });
  await expect(port.resolve("alice", { runtimeId: "grok-local", model: "gpt-fixture" })).rejects.toMatchObject({
    code: "invalidInput",
  });
  await expect(port.discover("bob", "grok-local")).rejects.toMatchObject({ code: "notFound" });
  await expect(registry.require({ owner: "bob", administrator: false }, "codex")).rejects.toMatchObject({
    code: "notFound",
  });
  const memberCatalog = await port.catalog("bob");
  expect(memberCatalog.runtimes.map((runtime) => runtime.id)).toEqual(["codex"]);
  expect(memberCatalog.profiles).toEqual([]);
  expect(memberCatalog.canManage).toBe(false);
  expect((await port.resolve("bob", { runtimeId: "codex" })).model).toBe("gpt-fixture");
  expect(changeRuntimeSelection({ runtimeId: "codex", model: "gpt-fixture", effort: "high" }, grok)).toEqual({
    runtimeId: "grok-local",
    model: "",
    effort: "",
  });
  const custom = {
    ...grok,
    models: [...grok.models, { id: "other", name: "Other", efforts: [] }],
  } as HarnessRuntimeView;
  expect(
    changeRuntimeSelection({ runtimeId: grok.id, model: "grok-fixture", effort: "high" }, custom, "other").effort,
  ).toBe("");
});
test("ACP application execution uses real MCP calls and configured model/effort with native tools removed", async () => {
  const { port, root, codexCalls } = await fixture();
  let answer = "",
    started = false;
  const engine = port.engine(
    "alice",
    { runtimeId: "grok-local", model: "grok-fixture", effort: "low" },
    root,
    "bot-chat",
  );
  const result = await engine.run(
    { prompt: "hello", instructions: "Reply to the human.", tools: [replyTool] },
    {
      signal: new AbortController().signal,
      started() {
        started = true;
      },
      async call(value) {
        expect(started).toBe(true);
        expect(value.name).toBe("panda_bot_chat_reply");
        answer = String((value.arguments as { text: string }).text);
        return { success: true, text: "Accepted" };
      },
    },
  );
  expect(result.status).toBe("completed");
  expect(answer).toContain("grok-fixture low");
  expect(codexCalls).toHaveLength(0);
  expect(engine.persistentSession).toBe(false);
});
for (const outcome of ["idle-disconnect", "idle-complete", "cancelled", "disconnected", "progressing"] as const)
  test(`ACP creation execution classifies ${outcome} and keeps productive runs alive`, async () => {
    const clock = new ManualRunClock();
    const { port, root, registry } = await fixture(undefined, clock);
    await port.discover("alice", "grok-local");
    const cancellation = new AbortController(),
      original = registry.agent.bind(registry);
    const opened = spyOn(registry, "agent").mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      value.agent.prompt = async (_session, _input, emit) => {
        if (outcome === "progressing") {
          for (let i = 0; i < 8; i++) {
            clock.advance(590000);
            await emit({ type: "activity" });
          }
          return { stopReason: "complete" };
        }
        if (outcome.startsWith("idle")) clock.advance(600001);
        else if (outcome === "cancelled") cancellation.abort(new Error("User cancelled"));
        if (outcome === "idle-complete") return { stopReason: "complete" };
        throw new Error("Private ACP transport failure");
      };
      return value;
    });
    cleanups.push(async () => opened.mockRestore());
    const run = port
      .engine("alice", { runtimeId: "grok-local", model: "grok-fixture", effort: "low" }, root, "creation")
      .run(
        { prompt: "Create a presentation", instructions: "Use scoped tools", tools: [replyTool] },
        {
          signal: cancellation.signal,
          started() {},
          async call() {
            throw new Error("Unexpected write");
          },
        },
      );
    if (outcome.startsWith("idle")) await expect(run).rejects.toMatchObject({ code: "APPLICATION_ENGINE_INACTIVE" });
    else if (outcome === "progressing") expect((await run).status).toBe("completed");
    else await expect(run).rejects.toThrow("Private ACP transport failure");
  });
test("ACP creation excludes the full duration of an application tool from inactivity", async () => {
  const clock = new ManualRunClock(),
    { port, root } = await fixture(undefined, clock);
  const result = await port
    .engine("alice", { runtimeId: "grok-local", model: "grok-fixture", effort: "low" }, root, "creation")
    .run(
      { prompt: "hello", instructions: "Use the reply tool", tools: [replyTool] },
      {
        signal: new AbortController().signal,
        started() {},
        async call() {
          clock.advance(3600000);
          return { success: true, text: "Saved" };
        },
      },
    );
  expect(result.status).toBe("completed");
});
test("MCP callbacks reject other callers and coalesce duplicate IDs without replaying a side effect", async () => {
  let calls = 0;
  const scope = { sessionId: "one", runId: "two" };
  const bridge = await applicationMcp(
    [replyTool],
    {
      signal: new AbortController().signal,
      started() {},
      async call() {
        calls++;
        await Bun.sleep(20);
        return { success: true, text: "accepted" };
      },
    },
    () => scope,
  );
  cleanups.push(() => bridge.close());
  const url = bridge.mcpServer.url,
    headers = Object.fromEntries(bridge.mcpServer.headers.map((h) => [h.name, h.value]));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: replyTool.name, arguments: { text: "one" } },
  });
  expect((await fetch(url, { method: "POST", body })).status).toBe(403);
  expect(
    (await fetch(url, { method: "POST", body, headers: { ...headers, Origin: "https://example.com" } })).status,
  ).toBe(403);
  const results = await Promise.all(
    [1, 2].map(async () => (await fetch(url, { method: "POST", body, headers })).json()),
  );
  expect(results[0]).toEqual(results[1]);
  expect(calls).toBe(1);
  const conflict = await (await fetch(url, { method: "POST", headers, body: body.replace('"one"', '"other"') })).json();
  expect(conflict.error).toBeDefined();
  expect(calls).toBe(1);
});
test("creation freezes runtime/model/effort and independent media configuration in the validated input profile", async () => {
  const { port } = await fixture();
  const models = async () => ({
    data: [
      {
        id: "gpt-media",
        model: "gpt-media",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  });
  const profiles = new CreationProfiles(
    { enabled: true, invalid: false, profiles: [{ id: "codex", engineId: "codex" }], defaultProfileId: "codex" },
    new Set(["codex"]),
    async () => "gpt-media",
    models,
    port,
  );
  const selected = await profiles.resolve(
    "codex",
    { runtimeId: "grok-local", model: "grok-fixture", effort: "low" },
    "alice",
  );
  expect(selected.engineId).toBe("harness-grok-local");
  expect(selected.media).toEqual({ model: "gpt-media", effort: "medium" });
  expect(creationEngineProfile(selected)).toEqual(selected);
});
test("Bot chat switches runtimes with bounded visible history and never resumes another vendor's native session", async () => {
  const { root, port, codexCalls } = await fixture();
  const store = new BotStore(":memory:");
  cleanups.push(async () => store.close());
  const bot = store.createBot("alice", {
    name: "Assistant",
    code: "multi-runtime",
    runtimeId: "codex",
    model: "gpt-fixture",
    effort: "high",
  });
  const service = new BotChatService(store);
  const worker = new BotChatWorker(
    store,
    (b) => port.engine(b.owner, b, root, "bot-chat"),
    () => root,
  );
  cleanups.push(() => worker.close());
  const send = async (text: string) => {
    await service.send("alice", bot.id, { requestId: randomUUID(), generation: 1, text });
    await worker.tick();
    for (let i = 0; i < 200; i++) {
      if (!(await service.snapshot("alice", bot.id)).busy) return;
      await Bun.sleep(20);
    }
    throw Error("Chat did not finish");
  };
  await send("My context is a blue panda.");
  store.updateBot("alice", bot.id, { runtimeId: "grok-local", model: "grok-fixture", effort: "low" });
  await send("What was my context?");
  const snapshot = await service.snapshot("alice", bot.id);
  expect(snapshot.messages).toHaveLength(4);
  expect(snapshot.messages.at(-1)?.text).toContain("blue panda");
  expect(snapshot.messages.at(-1)?.text).toContain("grok-fixture low");
  expect(snapshot.messages.at(-1)?.status).toBe("complete");
  store.updateBot("alice", bot.id, { runtimeId: "codex", model: "gpt-fixture", effort: "medium" });
  await send("Return to Codex");
  expect(codexCalls.at(-1)?.sessionId).toBeUndefined();
});
test("Bot background tasks dispatch to the selected ACP runtime and keep their scoped decision contract", async () => {
  const { root, port } = await fixture();
  const store = new BotStore(":memory:");
  cleanups.push(async () => store.close());
  const bot = store.createBot("alice", {
    name: "Reviewer",
    code: "grok-reviewer",
    runtimeId: "grok-local",
    model: "grok-fixture",
    effort: "low",
  });
  const task = store.submit(
    bot,
    { externalTaskId: "external", instructions: "Review", input: { text: "A known item", images: [] } },
    "key",
  ).task;
  const worker = new BotWorker(store, (b) => port.engine(b.owner, b, root, "bots"), root);
  cleanups.push(() => worker.close());
  await worker.tick();
  for (let i = 0; i < 200; i++) {
    if (store.task("alice", task.id).status === "completed") break;
    await Bun.sleep(20);
  }
  expect(store.task("alice", task.id)).toMatchObject({ status: "completed", decision: "complete" });
  expect(store.task("alice", task.id).reason).toContain("grok-fixture low");
});

test("editorial runtime processing returns a bounded proposal through the application tool without applying edits", async () => {
  const { port, root } = await fixture();
  const models = harnessEditorialModels(port, {
    connection: { mode: "isolated" },
    scratchRoot: join(root, "editorial"),
    engineId: "codex",
    purpose: "editorial",
    version: "fixture",
  });
  const profile = await models.resolve("alice", { runtimeId: "grok-local", model: "grok-fixture", effort: "low" });
  const result = await models.model("alice", profile).process(
    {
      schema: 1,
      mode: "proofread",
      segments: [{ id: "segment-1", path: [0, 0], start: 0, text: "This are a test." }],
      truncated: false,
    },
    { signal: new AbortController().signal, operationId: "one", generation: 1, attempt: 1 },
  );
  expect(JSON.parse(String(result)).edits).toEqual([
    { segmentId: "segment-1", before: "This are a test.", after: "This is a test.", reason: "Grammar correction" },
  ]);
});

test("creation snapshots support models without reasoning effort", async () => {
  const profiles = new CreationProfiles(
    {
      enabled: true,
      invalid: false,
      profiles: [{ id: "codex", engineId: "codex", effort: "high" }],
      defaultProfileId: "codex",
    },
    new Set(["codex"]),
    async () => "unused",
    undefined,
    {
      resolve: async () => ({ runtimeId: "plain-runtime", model: "plain-model", effort: "" }),
    } as never,
  );
  const profile = await profiles.resolve("codex", { runtimeId: "plain-runtime" }, "alice");
  expect(profile.effort).toBeUndefined();
  expect(creationEngineProfile(JSON.parse(JSON.stringify(profile)))).toMatchObject({
    runtimeId: "plain-runtime",
    model: "plain-model",
  });
});
