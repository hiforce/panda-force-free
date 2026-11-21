import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { HarnessConversations, type HarnessConversationOptions } from "../../src/server/harness/conversations.js";
import { HarnessStdioTransport } from "../../src/server/harness/adapters/stdio.js";
import type { HarnessAgent, HarnessAgentInfo } from "../../src/server/harness/ports.js";
import { HarnessError, type HarnessPermissionMode } from "../../src/shared/harness/contracts.js";
import { HarnessDiagnostics } from "../../src/server/harness/diagnostics.js";
const directories: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "panda-harness-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const administrator = { owner: "one", administrator: true };
const info: HarnessAgentInfo = {
  capabilities: {
    text: true,
    imageInput: true,
    fileInput: true,
    models: true,
    load: true,
    tools: true,
    permissions: true,
    imageGeneration: "unknown",
  },
  currentModel: "model",
  commands: [],
  models: [{ id: "model", name: "Model", efforts: [{ id: "high", name: "High" }] }],
};
async function eventually(predicate: () => Promise<boolean>) {
  for (let count = 0; count < 200; count++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("conditionTimeout");
}
async function fixture(
  options: {
    fail?: boolean;
    hold?: boolean;
    sourcePage?: HarnessConversationOptions["sourcePage"];
    initialInfo?: HarnessAgentInfo;
    sessionInfo?: HarnessAgentInfo;
    openFailure?: HarnessError;
  } = {},
) {
  const directory = await temporary(),
    metadata = new SQLiteHarnessMetadata(join(directory, "metadata.sqlite"));
  const prompts: Array<{ runtime: string; session: string; cwd: string; text: string; model: string | null }> = [];
  const openedModes: Array<HarnessPermissionMode | undefined> = [];
  let opened = 0,
    closed = 0;
  const open = async (cwd: string, id = randomUUID()) => {
    opened++;
    if (options.openFailure) throw options.openFailure;
    return { id, cwd, ...(options.sessionInfo ? { info: options.sessionInfo } : {}) };
  };
  let release: (() => void) | null = null;
  const registry = new HarnessRegistry(
    metadata,
    ["codex", "grok-build"].map((id) => ({
      id,
      name: id,
      kind: id === "codex" ? ("codex" as const) : ("grok-build" as const),
      deployment: "local" as const,
      factory: {
        create: async (): Promise<HarnessAgent> => ({
          initialize: async () => options.initialInfo ?? info,
          create: async (cwd, config) => {
            openedModes.push(config?.permissionMode);
            return open(cwd);
          },
          load: async (id, cwd, config) => {
            openedModes.push(config?.permissionMode);
            return open(cwd, id);
          },
          prompt: async (session, input, emit) => {
            prompts.push({ runtime: id, session: session.id, cwd: session.cwd, text: input.text, model: input.model });
            if (options.hold) await new Promise<void>((resolve) => (release = resolve));
            if (options.fail) throw Error("disconnect");
            await emit({ type: "text", text: `${id} reply` });
            return { stopReason: "complete" };
          },
          cancel: async () => release?.(),
          respondPermission: async () => {},
          close: async () => {
            closed++;
            release?.();
          },
        }),
      },
    })),
  );
  await registry.initialize();
  const conversations = new HarnessConversations({
    metadata,
    history: new JsonlHarnessHistory(join(directory, "history")),
    registry,
    workspace: async () => directory,
    authorize: async () => {},
    attachments: async () => [],
    sourcePage: options.sourcePage,
  });
  cleanups.push(async () => {
    await conversations.close();
    await metadata.close();
  });
  return {
    directory,
    metadata,
    registry,
    conversations,
    prompts,
    openedModes,
    lifecycle: () => ({ opened, closed }),
    release: () => release?.(),
  };
}
test("conversation deletion is owned, idempotent and durable, and fences every history or send entry", async () => {
  const f = await fixture();
  const created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
    id = created.conversation.id;
  await expect(f.conversations.delete({ owner: "other", administrator: true }, id)).rejects.toMatchObject({
    code: "notFound",
  });
  await writeFile(join(f.directory, "project-sentinel.txt"), "unchanged");
  await f.conversations.delete(administrator, id);
  await f.conversations.delete(administrator, id);
  expect(await readFile(join(f.directory, "project-sentinel.txt"), "utf8")).toBe("unchanged");
  expect((await f.conversations.list(administrator)).map((row) => row.id)).not.toContain(id);
  await expect(f.conversations.snapshot(administrator, id)).rejects.toMatchObject({ code: "notFound" });
  await expect(
    f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "Do not resurrect" }),
  ).rejects.toMatchObject({ code: "notFound" });
  await expect(f.conversations.rename(administrator, id, "Resurrect")).rejects.toMatchObject({ code: "notFound" });
  const stored = await f.metadata.read("conversation:" + id);
  expect(JSON.parse(stored!.data).archivedAt).toBeGreaterThan(0);
  expect(f.prompts).toHaveLength(0);
});
test("deleting an active Harness conversation is rejected without cancelling its execution", async () => {
  const f = await fixture({ hold: true });
  const created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
    id = created.conversation.id;
  const run = await f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "hello" });
  await eventually(async () => f.prompts.length === 1);
  await expect(f.conversations.delete(administrator, id)).rejects.toMatchObject({ code: "busy" });
  expect((await f.conversations.snapshot(administrator, id)).conversation.activeRunId).toBe(run.runId);
  f.release();
  await eventually(async () => (await f.conversations.snapshot(administrator, id)).run?.status === "complete");
  await f.conversations.delete(administrator, id);
  await expect(f.conversations.snapshot(administrator, id)).rejects.toMatchObject({ code: "notFound" });
});
test("an uncertain stopped conversation can be deleted without replaying the native prompt", async () => {
  const f = await fixture({ fail: true });
  const { conversation } = await f.conversations.create(administrator, { runtimeId: "grok-build" });
  await f.conversations.submit(administrator, conversation.id, {
    requestId: randomUUID(),
    text: "Do not retry automatically",
  });
  await eventually(
    async () => (await f.conversations.snapshot(administrator, conversation.id)).run?.status === "uncertain",
  );
  await f.conversations.delete(administrator, conversation.id);
  await expect(f.conversations.resolveUncertain(administrator, conversation.id)).rejects.toMatchObject({
    code: "notFound",
  });
  expect(f.prompts).toHaveLength(1);
});
describe("Harness runtime ownership, transactions and portable context", () => {
  test("permission changes are owned, revision fenced, frozen while active and reset across runtimes", async () => {
    const f = await fixture({
      hold: true,
      initialInfo: { ...info, capabilities: { ...info.capabilities, permissionModes: ["ask", "always-approve"] } },
    });
    await f.registry.probe(administrator, "grok-build", f.directory);
    const created = await f.conversations.create(administrator, { runtimeId: "grok-build" });
    const id = created.conversation.id;
    await expect(
      f.conversations.configurePermission(
        { owner: "other", administrator: true },
        id,
        "always-approve",
        created.conversation.revision,
      ),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      f.conversations.configurePermission(administrator, id, "full-access", created.conversation.revision),
    ).rejects.toMatchObject({ code: "capabilityUnavailable" });
    await expect(
      f.conversations.configurePermission(administrator, id, "unknown", created.conversation.revision),
    ).rejects.toMatchObject({ code: "invalidInput" });
    const configured = await f.conversations.configurePermission(
      administrator,
      id,
      "always-approve",
      created.conversation.revision,
    );
    await expect(
      f.conversations.configurePermission(administrator, id, "ask", created.conversation.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "one turn" });
    await eventually(async () => f.prompts.length === 1);
    expect(f.openedModes.at(-1)).toBe("always-approve");
    const active = await f.conversations.snapshot(administrator, id);
    await expect(
      f.conversations.configurePermission(administrator, id, "ask", active.conversation.revision),
    ).rejects.toMatchObject({ code: "busy" });
    expect(configured.conversation.permissionMode).toBe("always-approve");
    f.release();
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    const finished = await f.conversations.snapshot(administrator, id);
    const switched = await f.conversations.switch(administrator, id, "codex", finished.conversation.revision);
    expect(switched.conversation.permissionMode).toBe("ask");
    const unsupported = await fixture();
    await unsupported.registry.probe(administrator, "grok-build", unsupported.directory);
    await expect(
      unsupported.conversations.create(administrator, { runtimeId: "grok-build", permissionMode: "always-approve" }),
    ).rejects.toMatchObject({ code: "capabilityUnavailable" });
  });
  test("authenticated session models supersede the startup cache before dispatch validation", async () => {
    const sessionInfo = {
      ...info,
      currentModel: "new-model",
      models: [{ id: "new-model", name: "New model", efforts: [{ id: "high", name: "High" }] }],
    };
    const f = await fixture({ sessionInfo }),
      created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
      id = created.conversation.id;
    await f.conversations.submit(administrator, id, {
      requestId: randomUUID(),
      text: "Hello",
      model: "new-model",
      effort: "high",
    });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect((await f.conversations.snapshot(administrator, id)).run?.status).toBe("complete");
    expect(f.prompts[0]!.model).toBe("new-model");
    await f.conversations.submit(administrator, id, {
      requestId: randomUUID(),
      text: "Invalid model",
      model: "model",
      effort: "high",
    });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect((await f.conversations.snapshot(administrator, id)).run).toMatchObject({
      status: "error",
      error: "invalidInput",
    });
    expect(f.prompts).toHaveLength(1);
  });
  test("a connection probe opens an authenticated session and closes it even when authentication fails", async () => {
    const f = await fixture({ openFailure: new HarnessError("authentication", 503) });
    await expect(f.registry.probe(administrator, "grok-build", f.directory)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(f.lifecycle()).toEqual({ opened: 1, closed: 1 });
    expect((await f.registry.catalog(administrator)).runtimes.find((r) => r.id === "grok-build")?.status).toBe(
      "authentication",
    );
    expect(f.prompts).toHaveLength(0);
  });
  test("a successful probe publishes the authenticated session catalog without sending a prompt", async () => {
    const f = await fixture({ sessionInfo: { ...info, models: [{ id: "new-model", name: "New", efforts: [] }] } });
    const catalog = await f.registry.probe(administrator, "grok-build", f.directory);
    expect(catalog.runtimes.find((r) => r.id === "grok-build")).toMatchObject({
      status: "ready",
      models: [{ id: "new-model" }],
    });
    expect(f.prompts).toHaveLength(0);
    expect(f.lifecycle()).toEqual({ opened: 1, closed: 1 });
  });
  test("new Grok sessions observe atomically renewed account sources without changing the operator account", async () => {
    const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    const directory = await temporary(),
      account = join(directory, "account"),
      path = join(account, "auth.json");
    await mkdir(account);
    const expired = JSON.stringify({
      fixture: { access_token: "expired-fixture", refresh_token: "operator-only", rejectSession: true },
    });
    await writeFile(path, expired);
    const metadata = new SQLiteHarnessMetadata(join(directory, "profiles.sqlite"));
    cleanups.push(() => metadata.close());
    const registry = new HarnessRegistry(
      metadata,
      harnessProfiles(directory, {} as Driver, {
        PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
          {
            id: "grok-renewed",
            name: "Grok renewed",
            command: join(import.meta.dir, "../support/grok-acp-fixture.mjs"),
            accountHome: account,
          },
        ]),
        PATH: process.env.PATH,
      }),
    );
    await registry.initialize();
    await expect(registry.probe(administrator, "grok-renewed", directory)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(await readFile(path, "utf8")).toBe(expired);
    const renewed = JSON.stringify({
      fixture: { access_token: "renewed-fixture", refresh_token: "new-operator-only", rejectSession: false },
    });
    await writeFile(path + ".next", renewed);
    await rename(path + ".next", path);
    const catalog = await registry.probe(administrator, "grok-renewed", directory);
    expect(catalog.runtimes.find((r) => r.id === "grok-renewed")).toMatchObject({
      status: "ready",
      models: [{ id: "grok-fixture" }],
    });
    expect(await readFile(path, "utf8")).toBe(renewed);
  });
  test("explicit diagnostic messages coalesce repeats and keep workspaces and replies outside chat history", async () => {
    const f = await fixture();
    let cleaned = 0;
    const diagnostics = new HarnessDiagnostics(f.registry, async () => ({
      cwd: join(f.directory, "isolated-ping"),
      cleanup: async () => {
        cleaned++;
      },
    }));
    cleanups.push(() => diagnostics.close());
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      diagnostics.ping(administrator, "grok-build", requestId),
      diagnostics.ping(administrator, "grok-build", requestId),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "complete", reply: "grok-build reply" });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.text).toStartWith("hi\n");
    expect(f.prompts[0]!.cwd).toEndWith("isolated-ping");
    expect(cleaned).toBe(1);
    expect(await f.metadata.list("conversation")).toHaveLength(0);
    await expect(
      diagnostics.ping({ ...administrator, administrator: false }, "grok-build", randomUUID()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(diagnostics.ping(administrator, "codex", requestId)).rejects.toMatchObject({ code: "conflict" });
  });
  test("a timed-out diagnostic retains its receipt without resending and closes the native request", async () => {
    const f = await fixture({ hold: true }),
      diagnostics = new HarnessDiagnostics(f.registry, async () => ({ cwd: f.directory, cleanup: async () => {} }), 30);
    cleanups.push(() => diagnostics.close());
    const requestId = randomUUID();
    const first = diagnostics.ping(administrator, "grok-build", requestId);
    await expect(diagnostics.ping(administrator, "grok-build", randomUUID())).rejects.toMatchObject({ code: "busy" });
    expect(await first).toMatchObject({ status: "uncertain", error: "timeout" });
    expect(await diagnostics.ping(administrator, "grok-build", requestId)).toMatchObject({
      status: "uncertain",
      error: "timeout",
    });
    expect(f.prompts).toHaveLength(1);
    expect(f.lifecycle().closed).toBe(1);
  });
  test("separate runtime bindings preserve one visible transcript and transfer only missing visible messages", async () => {
    const f = await fixture(),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id;
    const send = async (text: string) => {
      const requestId = randomUUID();
      await f.conversations.submit(administrator, id, { requestId, text });
      await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    };
    await send("first user message");
    let snapshot = await f.conversations.snapshot(administrator, id);
    await f.conversations.switch(administrator, id, "grok-build", snapshot.conversation.revision);
    await send("second user message");
    snapshot = await f.conversations.snapshot(administrator, id);
    await f.conversations.switch(administrator, id, "codex", snapshot.conversation.revision);
    await send("third user message");
    snapshot = await f.conversations.snapshot(administrator, id);
    expect(snapshot.messages.filter((message) => message.role !== "tool")).toHaveLength(6);
    expect(f.prompts.map((prompt) => prompt.cwd)).toEqual([f.directory, f.directory, f.directory]);
    expect(f.prompts[1]!.text).toContain("first user message");
    expect(f.prompts[1]!.text).toContain("codex reply");
    expect(f.prompts[2]!.text).toContain("second user message");
    expect(f.prompts[2]!.text).not.toContain("first user message");
    expect(f.prompts[0]!.session).toBe(f.prompts[2]!.session);
    expect(f.prompts[0]!.session).not.toBe(f.prompts[1]!.session);
    const owners = await readdir(join(f.directory, "history"));
    expect(await readdir(join(f.directory, "history", owners[0]!))).toEqual([id]);
    await expect(f.conversations.snapshot({ owner: "two", administrator: true }, id)).rejects.toMatchObject({
      code: "notFound",
    });
  });
  test("repeated submission is coalesced; active execution cannot switch; defaults affect new conversations only", async () => {
    const f = await fixture({ hold: true }),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id,
      requestId = randomUUID();
    const first = await f.conversations.submit(administrator, id, { requestId, text: "one" });
    const second = await f.conversations.submit(administrator, id, { requestId, text: "one" });
    expect(second).toEqual({ runId: first.runId, replay: true });
    await expect(f.conversations.submit(administrator, id, { requestId, text: "changed" })).rejects.toMatchObject({
      code: "conflict",
    });
    const snapshot = await f.conversations.snapshot(administrator, id);
    await expect(
      f.conversations.switch(administrator, id, "grok-build", snapshot.conversation.revision),
    ).rejects.toMatchObject({ code: "busy" });
    const runtime = (await f.registry.catalog(administrator)).runtimes.find((value) => value.id === "grok-build")!;
    await f.registry.configure(administrator, { ...runtime, makeDefault: true });
    expect((await f.conversations.create(administrator, {})).conversation.runtimeId).toBe("grok-build");
    expect((await f.conversations.snapshot(administrator, id)).conversation.runtimeId).toBe("codex");
    await eventually(async () => f.prompts.length === 1);
    f.release();
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect(f.prompts).toHaveLength(1);
  });
  test("dispatch failure stays uncertain without silent resend; explicit recovery discards the unsafe native binding", async () => {
    const f = await fixture({ fail: true }),
      snapshot = await f.conversations.create(administrator, {}),
      id = snapshot.conversation.id,
      requestId = randomUUID();
    await f.conversations.submit(administrator, id, { requestId, text: "one" });
    await eventually(async () => (await f.conversations.snapshot(administrator, id)).run?.status === "uncertain");
    expect((await f.conversations.submit(administrator, id, { requestId, text: "one" })).replay).toBe(true);
    expect(f.prompts).toHaveLength(1);
    await eventually(async () => {
      try {
        await f.conversations.resolveUncertain(administrator, id);
        return true;
      } catch {
        return false;
      }
    });
    expect((await f.conversations.snapshot(administrator, id)).conversation.activeRunId).toBeNull();
  });
  test("metadata rolls back across await and hides uncommitted state", async () => {
    const directory = await temporary(),
      store = new SQLiteHarnessMetadata(join(directory, "metadata.sqlite"));
    cleanups.push(() => store.close());
    await expect(
      store.transaction(async (tx) => {
        await tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null);
        await Promise.resolve();
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.read("x")).toBeNull();
    await store.transaction(async (tx) => {
      await tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null);
    });
    await expect(
      store.transaction((tx) =>
        tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  test("JSONL ignores an interrupted tail and preserves the original committed frames", async () => {
    const directory = await temporary(),
      history = new JsonlHarnessHistory(directory),
      id = randomUUID();
    const first = { type: "status" as const, seq: 1, messageId: "x", status: "complete" as const };
    const offset = await history.append("owner", id, 0, [first]);
    await history.append("owner", id, offset, [{ ...first, seq: 2 }]);
    expect(await history.read("owner", id, offset)).toEqual([first]);
    const end = await history.append("owner", id, offset, [{ ...first, seq: 2, status: "error" }]);
    expect((await history.read("owner", id, end))[1]).toMatchObject({ status: "error" });
    const owner = (await readdir(directory))[0]!,
      path = join(directory, owner, id, "history.jsonl"),
      bytes = await readFile(path, "utf8");
    await writeFile(path, bytes.replace('"status":"complete"', '"status":"running" '));
    await expect(history.read("owner", id, end)).rejects.toMatchObject({ code: "historyCorrupt" });
  });
});
describe("Harness stdio protocol", () => {
  test("preserves fragmented UTF-8, waits for persisted notifications, handles bidirectional IDs and a definitive response before exit", async () => {
    const directory = await temporary(),
      script = join(directory, "agent.mjs");
    await writeFile(
      script,
      `import readline from 'node:readline'; const lines=readline.createInterface({input:process.stdin}); lines.on('line',line=>{const f=JSON.parse(line);if(f.method==='test'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,method:'permission',params:{}})+'\\n');}else if(f.result==='deny'){const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'text',params:{text:'你好'}})+'\\n');for(const byte of data)process.stdout.write(Buffer.from([byte]));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{ok:true}})+'\\n',()=>process.exit(0));}});`,
    );
    let persisted = false;
    const transport = new HarnessStdioTransport({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: process.env,
      onRequest: async () => "deny",
      onNotification: async (_method, params) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(params.text).toBe("你好");
        persisted = true;
      },
    });
    cleanups.push(() => transport.close());
    expect(await transport.request("test")).toEqual({ ok: true });
    expect(persisted).toBe(true);
  });
});

describe("bounded Harness handoff", () => {
  test("limits context independently of retained history and does not read attachment bodies", async () => {
    const { handoffContext } = await import("../../src/server/harness/context.js");
    const events = Array.from({ length: 1000 }, (_, index) => ({
      type: "message" as const,
      seq: index + 1,
      message: {
        id: String(index),
        seq: index + 1,
        runId: "run",
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        runtimeId: "codex",
        model: "model",
        text: `message-${index}:` + "文".repeat(2000),
        attachments: [],
        status: "complete" as const,
        createdAt: 1,
      },
    }));
    const handoff = handoffContext(events, {
      afterSeq: 0,
      exclude: [],
      earlierHistoryOmitted: false,
      maxBytes: 16000,
      maxMessages: 8,
    });
    expect(handoff.messages.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(handoff))).toBeLessThan(17000);
    expect(handoff.messages.at(-1)?.content).toContain("message-999");
    expect(handoff.earlierHistoryOmitted).toBe(true);
    expect(handoff.clipped).toBe(true);
  });
  test("reads only a bounded tail of a multi-gigabyte transcript", async () => {
    const { open } = await import("node:fs/promises");
    const directory = await temporary(),
      history = new JsonlHarnessHistory(directory),
      id = randomUUID();
    const event = { type: "status" as const, seq: 5000000, messageId: "x", status: "complete" as const };
    const initial = await history.append("owner", id, 0, [event]);
    const owner = (await readdir(directory))[0]!,
      path = join(directory, owner, id, "history.jsonl"),
      frame = await readFile(path),
      start = 3 * 1024 ** 3;
    const file = await open(path, "r+");
    try {
      await file.truncate(start + frame.length + 1);
      await file.write(Buffer.concat([Buffer.from("\n"), frame]), 0, frame.length + 1, start);
    } finally {
      await file.close();
    }
    const window = await history.window("owner", id, start + initial + 1);
    expect(window.events).toEqual([event]);
    expect(window.truncated).toBe(true);
    expect(window.startBytes).toBe(start + 1);
  });
});

describe("timestamp history retrieval", () => {
  test("uses UTC timestamps, returns bounded pages, handles clock reversal and ignores uncommitted index entries", async () => {
    const directory = await temporary();
    let clock = Date.parse("2026-11-20T12:00:00Z");
    const history = new JsonlHarnessHistory(directory, () => clock),
      id = randomUUID();
    const event = (seq: number, value: string) => ({
      type: "text" as const,
      seq,
      messageId: "x",
      text: value,
      runtimeId: "grok-build",
      runId: "run",
    });
    const first = await history.append("one", id, 0, [event(1, "decision one")]);
    clock -= 1000;
    const committed = await history.append("one", id, first, [event(2, "decision two"), event(3, "other")]);
    const page = await history.queryTime("one", id, committed, {
      from: clock,
      to: clock + 1000,
      query: "decision",
      limit: 1,
    });
    expect(page.records[0]).toMatchObject({ seq: 1, timestamp: "2026-11-20T12:00:00.000Z", runtimeId: "grok-build" });
    const next = await history.queryTime("one", id, committed, {
      from: clock,
      to: clock + 1000,
      query: "decision",
      limit: 1,
      cursor: page.cursor!,
    });
    expect(next.records[0]!.seq).toBe(2);
    await history.append("one", id, committed, [event(4, "uncommitted")]);
    const snapshot = await history.queryTime("one", id, committed, { from: clock, to: clock + 1000 });
    expect(snapshot.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    const final = await history.append("one", id, committed, [event(4, "replacement")]);
    expect(
      (await history.queryTime("one", id, final, { from: clock, to: clock + 1000, query: "replacement" })).records,
    ).toHaveLength(1);
    const reference = await history.reference("one", id, final);
    const { runHarnessHistoryQuery } = await import("../../src/server/harness/history-cli.js");
    const cli = await runHarnessHistoryQuery([
      "--file",
      reference.path,
      "--committed-bytes",
      String(final),
      "--from",
      new Date(clock).toISOString(),
      "--to",
      new Date(clock + 1000).toISOString(),
      "--query",
      "replacement",
    ]);
    expect(cli.records[0]!.text).toBe("replacement");
  });
});

describe("Harness browser contracts", () => {
  test("keeps generated guidance out of titles and portable history while reconciling the client message alias", async () => {
    const f = await fixture(),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id;
    const input =
      'Visible user message.\n<panda_session_skills>\n{"guidance":"internal guidance"}\n</panda_session_skills>';
    await f.conversations.submit(administrator, id, { requestId: randomUUID(), clientId: "local-100-1", text: input });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    const snapshot = await f.conversations.snapshot(administrator, id);
    expect(snapshot.conversation.title).toBe("Visible user message.");
    expect(snapshot.messages[0]!.clientId).toBe("local-100-1");
    const { harnessPresentation } = await import("../../src/shared/harness/presentation.js");
    expect(harnessPresentation(snapshot).turns[0]!.items[0]!.clientId).toBe("local-100-1");
    const { handoffContext } = await import("../../src/server/harness/context.js");
    const pack = handoffContext([{ type: "message", seq: 1, message: { ...snapshot.messages[0]!, text: input } }], {
      afterSeq: 0,
      exclude: [],
      earlierHistoryOmitted: false,
    });
    expect(pack.messages[0]!.content).toBe("Visible user message.");
  });
  test("a late model catalog cannot overwrite the newly selected runtime", async () => {
    const { createModelCatalogLoader } = await import("../../src/client/session-controls/model-loader.js");
    let scope = "codex",
      resolveFirst: ((value: unknown) => void) | undefined;
    const accepted: unknown[] = [],
      failures: unknown[] = [];
    const load = createModelCatalogLoader({
      context: () => scope,
      request: async () =>
        scope === "codex"
          ? await new Promise((resolve) => (resolveFirst = resolve))
          : { type: "rpc/result", result: { data: [{ model: "grok" }] } },
      setStatus: () => {},
      changed: () => {},
      accept: (value) => accepted.push(value),
      failed: (error) => failures.push(error),
    });
    const old = load({ attempts: 1 });
    scope = "grok";
    await load({ attempts: 1 });
    resolveFirst!({ type: "rpc/result", result: { data: [{ model: "codex" }] } });
    await old;
    expect(accepted).toEqual([[{ model: "grok" }]]);
    expect(failures).toEqual([]);
  });
});

describe("Harness source history and materials", () => {
  test("loads older visible source pages without exporting native bindings or reading the whole source", async () => {
    const calls: string[] = [];
    const f = await fixture({
      sourcePage: async (_principal, id, cursor) => {
        calls.push(`${id}:${cursor}`);
        return {
          cwd: "",
          title: "",
          cursor: null,
          history: [{ id: "old-user", runId: "old-turn", role: "user", text: "An earlier decision", createdAt: 1000 }],
        };
      },
    });
    const created = await f.conversations.create(administrator, {
      source: { threadId: "original", cursor: "opaque" },
      history: [{ id: "recent-user", runId: "recent-turn", role: "user", text: "Continue", createdAt: 2000 }],
    });
    expect(created.history.nextCursor).toStartWith("source:");
    const older = await f.conversations.snapshot(administrator, created.conversation.id, {
      beforeBytes: 0,
      sourceCursor: "opaque",
      beforeSeq: 1,
    });
    expect(older.messages[0]).toMatchObject({ id: "old-user", seq: 0, createdAt: 1000 });
    expect(calls).toEqual(["original:opaque"]);
    const { harnessPresentation } = await import("../../src/shared/harness/presentation.js");
    const { mergeConversationHistory } = await import("../../src/client/ui-core.js");
    const current = harnessPresentation(created),
      page = harnessPresentation(older);
    const merged = mergeConversationHistory(
      current,
      { thread: page, history: { mode: "delta", turns: page.turns, nextCursor: null } },
      { page: true },
    );
    expect(merged.turns.map((turn) => turn.id)).toEqual(["old-turn", "recent-turn"]);
    const list = await f.conversations.list(administrator);
    expect(JSON.stringify(list)).not.toMatch(/"(source|owner|historyBytes|bindings|permissions|lastRunId)"/);
    expect(JSON.stringify(created.conversation)).not.toContain("original");
    await expect(
      f.conversations.snapshot({ owner: "other", administrator: true }, created.conversation.id),
    ).rejects.toMatchObject({ code: "notFound" });
  });
  test("stages only explicitly selected owned bytes, preserves the original filename, rejects links and conflicting staged files", async () => {
    const { HarnessMaterials } = await import("../../src/server/harness/materials.js");
    const root = await temporary(),
      id = randomUUID(),
      bytes = Buffer.from("Selected document");
    const material = { id, name: "项目说明.txt", kind: "file" as const, digest: "fixture" };
    const resolver = new HarnessMaterials({
      roots: [root],
      allows: (value) => value.startsWith(root + "/"),
      materials: () => ({
        prepare: async (owner, refs) => {
          if (owner !== "one" || JSON.stringify(refs) !== JSON.stringify([{ materialId: id }])) throw Error("notFound");
          return [material];
        },
        read: async () => ({ success: true, text: "" }),
        readOriginal: async () => bytes,
      }),
    });
    const f = await fixture(),
      created = await f.conversations.create(administrator, {});
    const conversation = { ...created.conversation, owner: "one", historyBytes: 0, cwd: root };
    const [selected] = await resolver.resolve(administrator, [`material:${id}`], conversation);
    expect(selected!.name).toBe(material.name);
    expect(await readFile(selected!.path)).toEqual(bytes);
    expect(selected!.url).toBe(`/api/chat-materials/original?id=${id}`);
    expect((await resolver.resolve(administrator, [`material:${id}`], conversation))[0]!.path).toBe(selected!.path);
    await expect(
      resolver.resolve({ owner: "two", administrator: true }, [`material:${id}`], conversation),
    ).rejects.toThrow();
    await writeFile(selected!.path, "Conflict");
    await expect(resolver.resolve(administrator, [`material:${id}`], conversation)).rejects.toMatchObject({
      code: "conflict",
    });
    const outside = join(root, "outside.txt"),
      link = join(root, "attachments", "input", "link.txt");
    await writeFile(outside, "Private unrelated file");
    await mkdir(join(root, "attachments", "input"), { recursive: true });
    await symlink(outside, link);
    await expect(resolver.resolve(administrator, [link], conversation)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      resolver.resolve(administrator, ["https://unrelated.example/file"], conversation),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("Codex Harness adapter lifecycle", () => {
  test("applies the selected native approval and sandbox policies on every resumed turn", async () => {
    const { CodexHarnessAgent } = await import("../../src/server/harness/adapters/codex.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    let listener: Parameters<Driver["subscribe"]>[0] | undefined;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const driver = {
      subscribe(fn: Parameters<Driver["subscribe"]>[0]) {
        listener = fn;
        return () => {};
      },
      sessions: { resume: async () => ({ id: "native", cwd: "/workspace" }) },
      execute: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session.create") return { thread: { id: "native", cwd: "/workspace" } };
        listener!({
          kind: "notification",
          envelope: {
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "turn", status: "completed" } },
          },
        });
        return { turn: { id: "turn", status: "completed" } };
      },
    } as unknown as Driver;
    const agent = new CodexHarnessAgent(driver);
    for (const permissionMode of ["full-access", "ask"] as const) {
      const session = await agent.load("native", "/workspace", { permissionMode });
      await agent.prompt(
        session,
        { text: "hello", attachments: [], model: null, effort: null, operationId: randomUUID() },
        async () => {},
      );
      const input = calls.at(-1)!.params;
      expect(input.approvalPolicy).toBe(permissionMode === "full-access" ? "never" : "on-request");
      expect(input.sandboxPolicy).toEqual(
        permissionMode === "full-access"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: ["/workspace"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
      );
    }
    await expect(agent.load("native", "/workspace", { permissionMode: "always-approve" })).rejects.toMatchObject({
      code: "capabilityUnavailable",
    });
    await agent.close();
  });
  test("retains a verified terminal event when the dispatch acknowledgement is lost", async () => {
    const { CodexHarnessAgent } = await import("../../src/server/harness/adapters/codex.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    let listener: Parameters<Driver["subscribe"]>[0] | undefined;
    const calls: string[] = [],
      deltas: string[] = [];
    const driver = {
      subscribe(fn: Parameters<Driver["subscribe"]>[0]) {
        listener = fn;
        return () => {};
      },
      sessions: { resume: async () => ({ id: "native", cwd: "/workspace" }) },
      execute: async (method: string) => {
        calls.push(method);
        listener!({
          kind: "notification",
          envelope: { method: "item/agentMessage/delta", params: { threadId: "native", delta: "Confirmed reply" } },
        });
        listener!({
          kind: "notification",
          envelope: {
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "turn", status: "completed" } },
          },
        });
        await Promise.resolve();
        throw Error("Dispatch acknowledgement lost");
      },
    } as unknown as Driver;
    const agent = new CodexHarnessAgent(driver),
      session = await agent.load("native", "/workspace");
    const result = await agent.prompt(
      session,
      { text: "Hello", attachments: [], model: null, effort: null, operationId: randomUUID() },
      async (event) => {
        if (event.type === "text") deltas.push(event.text);
      },
    );
    expect(result.stopReason).toBe("complete");
    expect(deltas).toEqual(["Confirmed reply"]);
    expect(calls).toEqual(["input.start"]);
    await agent.close();
  });
});
