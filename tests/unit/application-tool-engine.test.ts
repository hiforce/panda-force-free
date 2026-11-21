import { ManualRunClock } from "../support/run-clock.js";
import { expect, test } from "bun:test";
import type { CodexTransportOptions } from "../../src/server/engines/codex-transport.js";
import type { ApplicationRunCallbacks } from "../../src/shared/engine/application-tools.js";
import { createCodexApplicationEngine } from "../../src/server/engines/application-tools/codex.js";

const input = {
  prompt: "Write a project document",
  instructions: "Use only the declared application tool.",
  tools: [{ name: "panda_documents_create", description: "Save the document", inputSchema: { type: "object" } }],
};
function fixture(
  overrides: {
    budgetClock?: ManualRunClock;
    timeoutMs?: number;
    purpose?: "creation" | "knowledge" | "bots";
    model?: string;
    effort?: string;
  } = {},
) {
  let wire!: CodexTransportOptions,
    closed = false,
    turns = 0;
  const requests: { method: string; params?: Record<string, unknown> }[] = [],
    responses: Record<string, unknown>[] = [];
  let onTurn = async (): Promise<unknown> => ({ turn: { id: "owned-run" } });
  const engine = createCodexApplicationEngine(
    {
      connection: { mode: "shared", socketPath: "/isolated/test.sock" },
      scratchDirectory: "/isolated/empty",
      version: "test",
      ...overrides,
    },
    (options) => {
      wire = options;
      return {
        get connected() {
          return !closed;
        },
        async request(method, params) {
          if (wire.isShuttingDown()) throw new Error("Transport already closed");
          requests.push({ method, params });
          if (method === "model/list")
            return {
              data: [
                { model: "default-model", isDefault: true, defaultReasoningEffort: "medium" },
                { model: "other-model", defaultReasoningEffort: "low" },
              ],
            };
          if (method === "thread/start" || method === "thread/resume") return { thread: { id: "owned-session" } };
          if (method === "turn/start") {
            turns++;
            return onTurn();
          }
          return {};
        },
        sendRaw(value) {
          responses.push(value as Record<string, unknown>);
        },
        start() {},
        terminate() {
          closed = true;
        },
        cancelRestart() {},
        rejectPending() {},
        fullyStopped: () => closed,
      };
    },
  );
  const controller = new AbortController(),
    callbacks: ApplicationRunCallbacks = {
      signal: controller.signal,
      started() {},
      call: async () => ({ success: true, text: '{"documentId":"actual"}' }),
    };
  return {
    engine,
    requests,
    responses,
    callbacks,
    controller,
    run: () => engine.run(input, callbacks),
    closed: () => closed,
    turns: () => turns,
    onTurn(value: typeof onTurn) {
      onTurn = value;
    },
    call(id: number, params: Record<string, unknown> = {}, method = "item/tool/call") {
      wire.onMessage({
        id,
        method,
        params: {
          threadId: "owned-session",
          turnId: "owned-run",
          tool: "panda_documents_create",
          callId: "call-" + id,
          arguments: { title: "Title", body: {} },
          ...params,
        },
      });
    },
    complete(id = "owned-run", status = "completed", error?: unknown) {
      const turn = { id, status, ...(error === undefined ? {} : { error }) };
      wire.onMessage({
        method: "turn/completed",
        params: { threadId: "owned-session", turn },
      });
    },
    message(item: { type: string; text: string }, threadId = "owned-session") {
      wire.onMessage({
        method: "item/completed",
        params: { threadId, turnId: "owned-run", item: { id: "message", ...item } },
      });
    },
    notification(method: string, params: Record<string, unknown>) {
      wire.onMessage({ method, params });
    },
    disconnect() {
      wire.onDisconnected(1006, null);
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Application engine fixture did not settle");
    await Bun.sleep(1);
  }
}

test("a scoped run advertises application tools only and waits for application binding before dispatching an early callback", async () => {
  const f = fixture();
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const binding = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.callbacks.started = async (scope) => {
    expect(scope).toEqual({ sessionId: "owned-session", runId: "owned-run" });
    entered();
    await ready;
  };
  f.callbacks.call = async (call) => {
    calls++;
    expect(call.name).toBe("panda_documents_create");
    expect(call.sessionId).toBe("owned-session");
    return { success: true, text: "Saved" };
  };
  f.onTurn(async () => {
    f.call(51);
    return { turn: { id: "owned-run" } };
  });
  const running = f.run();
  await binding;
  expect(calls).toBe(0);
  expect(f.responses).toEqual([]);
  const thread = f.requests[0].params!;
  expect(thread.sandbox).toBe("read-only");
  expect(thread.approvalPolicy).toBe("never");
  expect(thread.ephemeral).toBe(true);
  expect((thread.config as Record<string, unknown>).mcp_servers).toEqual({});
  expect((thread.config as Record<string, unknown>)["features.shell_tool"]).toBe(false);
  expect((thread.config as Record<string, unknown>)["features.multi_agent"]).toBe(false);
  expect(thread.dynamicTools).toMatchObject([{ name: "panda_documents_create" }]);
  expect(f.requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
  release();
  await until(() => calls === 1 && f.responses.length === 1);
  expect(f.responses[0]).toEqual({
    id: 51,
    result: { success: true, contentItems: [{ type: "inputText", text: "Saved" }] },
  });
  f.complete();
  expect((await running).status).toBe("completed");
  expect(f.closed()).toBe(true);
});

test("completion arriving before the start acknowledgement is retained until its owned run is bound", async () => {
  const f = fixture();
  let bound = false;
  f.callbacks.started = () => {
    bound = true;
  };
  f.onTurn(async () => {
    f.complete("foreign-run");
    f.complete();
    return { turn: { id: "owned-run" } };
  });
  expect(await f.run()).toEqual({ sessionId: "owned-session", runId: "owned-run", status: "completed" });
  expect(bound).toBe(true);
  expect(f.turns()).toBe(1);
});

test("foreign requests, undeclared tools and ordinary approvals never enter the application dispatcher", async () => {
  const f = fixture();
  let calls = 0;
  f.callbacks.call = async () => {
    calls++;
    return { success: true, text: "Saved" };
  };
  const running = f.run();
  await until(() => f.requests.length === 2);
  await Bun.sleep(1);
  f.call(1, { threadId: "other-session" });
  f.call(2, { turnId: "old-run" });
  f.call(3, { tool: "shell" });
  f.call(4, {}, "execCommandApproval");
  await until(() => f.responses.length === 4);
  expect(calls).toBe(0);
  expect(f.responses.every((response) => (response.error as { code: number }).code === -32601)).toBe(true);
  f.complete();
  await running;
});

test("questions use their own scoped callback and validated answers without the conversation approval registry", async () => {
  const f = fixture();
  let asked = 0;
  f.callbacks.question = async (scope, questions) => {
    expect(scope.runId).toBe("owned-run");
    expect(questions[0].id).toBe("audience");
    asked++;
    return { audience: { answers: ["Developers"] } };
  };
  const running = f.run();
  await until(() => f.requests.length === 2);
  await Bun.sleep(1);
  f.call(
    1,
    { questions: [{ id: "audience", question: "Audience?", options: [{ label: "Developers" }] }] },
    "item/tool/requestUserInput",
  );
  await until(() => f.responses.length === 1);
  expect(asked).toBe(1);
  expect(f.responses[0]).toEqual({ id: 1, result: { answers: { audience: { answers: ["Developers"] } } } });
  f.complete();
  await running;
});

test("cancellation interrupts only the owned run and suppresses late callbacks after connection detach", async () => {
  const f = fixture();
  let release!: () => void,
    called = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.callbacks.call = async () => {
    called = true;
    await held;
    return { success: true, text: "Late" };
  };
  const running = f.run().catch((error: Error) => error);
  await until(() => f.requests.length === 2);
  await Bun.sleep(1);
  f.call(1);
  await until(() => called);
  f.controller.abort();
  expect(await running).toBeInstanceOf(Error);
  expect(String(await running)).toContain("interrupted");
  expect(f.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
    { method: "turn/interrupt", params: { threadId: "owned-session", turnId: "owned-run" } },
  ]);
  expect(f.closed()).toBe(true);
  release();
  await Bun.sleep(1);
  expect(f.responses).toEqual([]);
});

test("a disconnect never resends an uncertain turn and model-visible failures exclude private exception text", async () => {
  const f = fixture();
  f.callbacks.call = async () => {
    throw new Error("Private /path and secret credential");
  };
  const running = f.run().catch((error: Error) => error);
  await until(() => f.requests.length === 2);
  await Bun.sleep(1);
  f.call(1);
  await until(() => f.responses.length === 1);
  expect(JSON.stringify(f.responses)).not.toContain("credential");
  expect(JSON.stringify(f.responses)).not.toContain("/path");
  f.disconnect();
  expect(String(await running)).toContain("disconnected");
  expect(f.turns()).toBe(1);
  expect(f.closed()).toBe(true);
});

test("persistent application runs resume only the supplied thread and retain the restricted policy", async () => {
  const f = fixture();
  const running = f.engine.run({ ...input, persistent: true, sessionId: "owned-session" }, f.callbacks);
  await until(() => f.turns() === 1);
  f.complete();
  await running;
  const resumed = f.requests.find((request) => request.method === "thread/resume")!;
  expect(resumed.params?.threadId).toBe("owned-session");
  expect(resumed.params?.sandbox).toBe("read-only");
  expect(resumed.params?.approvalPolicy).toBe("never");
  expect(f.requests.some((request) => request.method === "thread/start")).toBe(false);
});

test("failed application turns retain safe quota classification instead of discarding the engine failure", async () => {
  const f = fixture({ purpose: "bots" });
  const running = f.run();
  await until(() => f.turns() === 1);
  await Bun.sleep(1);
  f.complete("foreign-run", "failed", { codexErrorInfo: "unauthorized" });
  f.complete("owned-run", "failed", {
    codexErrorInfo: "rateLimitExceeded",
    message: "Private provider quota, request URL and credential",
  });
  const result = await running;
  expect(result).toEqual({ sessionId: "owned-session", runId: "owned-run", status: "failed", failure: "rateLimited" });
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(f.turns()).toBe(1);
});

test("application image tool results use native image content instead of URL text", async () => {
  const f = fixture();
  f.callbacks.call = async () => ({
    success: true,
    text: "Current task image",
    images: ["data:image/jpeg;base64,YWJj"],
  });
  const running = f.run();
  await until(() => f.turns() === 1);
  f.call(41);
  await until(() => f.responses.length === 1);
  expect(f.responses[0]).toEqual({
    id: 41,
    result: {
      success: true,
      contentItems: [
        { type: "inputText", text: "Current task image" },
        { type: "inputImage", imageUrl: "data:image/jpeg;base64,YWJj" },
      ],
    },
  });
  f.complete();
  await running;
});

test("progress exposes only bounded visible assistant text from the bound execution", async () => {
  const f = fixture(),
    messages: string[] = [];
  f.callbacks.message = (text) => {
    messages.push(text);
  };
  const run = f.run();
  await until(() => f.requests.some((request) => request.method === "turn/start"));
  await Bun.sleep(1);
  f.message({ type: "agentMessage", text: "The outline is ready." });
  f.message({ type: "reasoning", text: "Private reasoning" });
  f.message({ type: "agentMessage", text: "Foreign text" }, "another-session");
  f.message({ type: "agentMessage", text: "x".repeat(9000) });
  f.complete();
  await run;
  f.message({ type: "agentMessage", text: "Late text" });
  expect(messages).toEqual(["The outline is ready.", "x".repeat(8000)]);
});

test("an exhausted creation inactivity deadline interrupts only its owned run", async () => {
  const f = fixture({ timeoutMs: 1000, purpose: "creation" });
  await expect(f.run()).rejects.toMatchObject({ code: "APPLICATION_ENGINE_INACTIVE" });
  expect(f.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
    { method: "turn/interrupt", params: { threadId: "owned-session", turnId: "owned-run" } },
  ]);
  expect(f.closed()).toBe(true);
});

test("application runs pass the chosen effort and resolve model defaults on resumed turns", async () => {
  for (const [model, selected, expectedModel, expectedEffort] of [
    ["other-model", "high", "other-model", "high"],
    ["other-model", "", "other-model", "low"],
    [undefined, "", "default-model", "medium"],
  ] as const) {
    const f = fixture({ ...(model ? { model } : {}), effort: selected });
    const running = f.engine.run({ ...input, persistent: true, sessionId: "owned-session" }, f.callbacks);
    await until(() => f.requests.some((r) => r.method === "turn/start"));
    expect(f.requests.find((r) => r.method === "thread/resume")?.params?.model).toBe(expectedModel);
    expect(f.requests.find((r) => r.method === "turn/start")?.params?.effort).toBe(expectedEffort);
    f.complete();
    expect((await running).status).toBe("completed");
  }
});

test("creation reasoning activity renews inactivity without exposing private content", async () => {
  const clock = new ManualRunClock(),
    f = fixture({ purpose: "creation", timeoutMs: 1000, budgetClock: clock }),
    messages: string[] = [];
  f.callbacks.message = (text) => {
    messages.push(text);
  };
  const run = f.run();
  await until(() => f.turns() === 1);
  await Bun.sleep(1);
  for (let i = 0; i < 10; i++) {
    clock.advance(900);
    f.notification("item/reasoning/textDelta", {
      threadId: "owned-session",
      turnId: "owned-run",
      delta: "Private reasoning",
    });
  }
  f.complete();
  expect((await run).status).toBe("completed");
  expect(messages).toEqual([]);
});
test("foreign activity cannot keep a stalled creation alive", async () => {
  const clock = new ManualRunClock(),
    f = fixture({ purpose: "creation", timeoutMs: 1000, budgetClock: clock });
  const run = f.run();
  await until(() => f.turns() === 1);
  await Bun.sleep(1);
  clock.advance(900);
  f.notification("item/reasoning/textDelta", { threadId: "other-session", turnId: "owned-run", delta: "Foreign" });
  clock.advance(101);
  await expect(run).rejects.toMatchObject({ code: "APPLICATION_ENGINE_INACTIVE" });
});
test("creation waits for long tools and user answers without consuming inactivity", async () => {
  for (const method of ["item/tool/call", "item/tool/requestUserInput"]) {
    const clock = new ManualRunClock(),
      f = fixture({ purpose: "creation", timeoutMs: 1000, budgetClock: clock });
    f.callbacks.call = async () => {
      clock.advance(10000);
      return { success: true, text: "Saved" };
    };
    f.callbacks.question = async () => {
      clock.advance(10000);
      return { question: { answers: ["One"] } };
    };
    const run = f.run();
    await until(() => f.turns() === 1);
    await Bun.sleep(1);
    f.call(
      80,
      method.includes("requestUserInput")
        ? {
            questions: [
              { id: "question", header: "Choice", question: "Choose", options: [{ label: "One", description: "One" }] },
            ],
          }
        : {},
      method,
    );
    await until(() => f.responses.length === 1);
    clock.advance(900);
    f.complete();
    expect((await run).status).toBe("completed");
  }
});
