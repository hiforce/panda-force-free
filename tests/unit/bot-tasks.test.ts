import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { botTaskInput } from "../../src/shared/bots/contracts.js";
import { publicBotAddress } from "../../src/server/bots/network.js";
import type { ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";
const input = () =>
  botTaskInput({
    externalTaskId: "era-1",
    instructions: "Keep clothing and shoes, discard accessories; review if uncertain",
    input: { text: "A backpack", images: [] },
    callbacks: {
      discard: {
        url: "https://era.example.com/discard",
        method: "POST",
        body: { taskId: "era-1" },
        success: { path: "success", equals: true },
      },
    },
  });
function fixture(path = ":memory:") {
  const store = new BotStore(path);
  const bot = store.createBot("owner", {
    code: "product-review",
    name: "Product review",
    callbackHosts: ["era.example.com"],
  });
  return { store, bot };
}
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Test timed out");
    await Bun.sleep(5);
  }
}
function engine(decision: "keep" | "discard" | "review", seen: string[] = []): ApplicationToolEngine {
  return {
    id: "fixture",
    async run(value, callbacks) {
      seen.push(value.sessionId ?? "new");
      await callbacks.session?.("bot-session");
      await callbacks.started({ sessionId: "bot-session", runId: "run-1" });
      await callbacks.call({
        sessionId: "bot-session",
        runId: "run-1",
        callId: "call-1",
        name: "panda_bot_decide",
        arguments: {
          taskId: JSON.parse(value.prompt).taskId,
          decision,
          reason: "Product evidence",
          ...(decision === "review"
            ? {
                review: {
                  question: "Which product evidence should guide the next step?",
                  options: [
                    { id: "inspect", label: "Inspect the product source again" },
                    { id: "provide", label: "I will provide more product details" },
                  ],
                },
              }
            : {}),
        },
      });
      return { sessionId: "bot-session", runId: "run-1", status: "completed" };
    },
  };
}

test("bot keys are owner scoped, hashed, expiring and revocable", () => {
  const { store, bot } = fixture();
  try {
    const { secret, key } = store.issue("owner", { name: "ERA", botIds: [bot.id], days: 1 });
    expect(store.authenticate(secret)).toEqual({ owner: "owner", botIds: [bot.id] });
    expect(JSON.stringify(store.keys("owner"))).not.toContain(secret);
    expect(store.keys("other")).toEqual([]);
    expect(() => store.bot("other", bot.id)).toThrow();
    expect(() => store.issue("other", { name: "Bad", botIds: [bot.id] })).toThrow();
    store.revoke("owner", key.id);
    expect(() => store.authenticate(secret)).toThrow();
  } finally {
    store.close();
  }
});
test("deduplicates identical task submissions and rejects changed payload or unapproved callback", () => {
  const { store, bot } = fixture();
  try {
    const first = store.submit(bot, input(), "idem");
    expect(store.submit(bot, input(), "idem").task.id).toBe(first.task.id);
    expect(store.submit(bot, input(), "idem").duplicate).toBe(true);
    expect(() => store.submit(bot, { ...input(), instructions: "changed" }, "idem")).toThrow();
    const bad = input();
    bad.callbacks!.discard.url = "https://other.example.com/discard";
    expect(() => store.submit(bot, bad, "other")).toThrow();
    expect(() =>
      botTaskInput({
        ...input(),
        input: { text: "x", images: ["https://a.com/1", "https://a.com/2", "https://a.com/3"] },
      }),
    ).toThrow();
  } finally {
    store.close();
  }
});
test("leases serialize each bot and fence expired workers across store connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-")),
    { store, bot } = fixture(join(root, "state.sqlite")),
    second = new BotStore(join(root, "state.sqlite"));
  try {
    store.submit(bot, input(), "1");
    store.submit(bot, input(), "2");
    const first = store.claim()!;
    expect(second.claim()).toBeNull();
    store.db.query("UPDATE bot_tasks SET leaseUntil=0 WHERE id=?").run(first.task.id);
    const next = second.claim()!;
    expect(next.task.id).not.toBe(first.task.id);
    expect(store.task("owner", first.task.id).status).toBe("review");
    expect(() => store.update(first.task, first.lease, true)).toThrow();
  } finally {
    second.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("reuses the bot session and keeps uncertain tasks without dispatching callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-")),
    { store, bot } = fixture(),
    seen: string[] = [];
  let posts = 0;
  const worker = new BotWorker(
    store,
    () => engine("review", seen),
    root,
    async () => {
      posts++;
      throw new Error("Must not call");
    },
  );
  try {
    const a = store.submit(bot, input(), "1").task,
      b = store.submit(bot, input(), "2").task;
    worker.start();
    await until(() => store.task("owner", b.id).status === "review");
    expect(store.task("owner", a.id).status).toBe("review");
    expect(seen).toEqual(["new", "bot-session"]);
    expect(posts).toBe(0);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("ambiguous callback outcomes do not retry automatically; explicit retry reuses decision and stable idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-")),
    { store, bot } = fixture();
  let calls = 0,
    models = 0;
  const headers: string[] = [];
  const worker = new BotWorker(
    store,
    () => {
      models++;
      return engine("discard");
    },
    root,
    async (_url, options) => {
      calls++;
      headers.push(options.headers!["idempotency-key"]!);
      if (calls === 1) throw new Error("Timeout");
      return { status: 200, type: "application/json", body: Buffer.from('{"success":true}') };
    },
  );
  try {
    const a = store.submit(bot, input(), "1").task;
    worker.start();
    await until(() => store.task("owner", a.id).status === "callback_unknown");
    worker.tick();
    await Bun.sleep(20);
    expect(calls).toBe(1);
    store.review("owner", a.id, "discard");
    worker.tick();
    await until(() => store.task("owner", a.id).status === "discarded");
    expect(models).toBe(1);
    expect(headers[0]).toBe(headers[1]);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a 200 business failure is not recorded as a successful discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-")),
    { store, bot } = fixture();
  const worker = new BotWorker(
    store,
    () => engine("discard"),
    root,
    async () => ({
      status: 200,
      type: "application/json",
      body: Buffer.from('{"success":false,"code":"TASK_NOT_FOUND","displayText":"Publishing task does not exist"}'),
    }),
  );
  try {
    const task = store.submit(bot, input(), "1").task;
    worker.start();
    await until(() => store.task("owner", task.id).status === "callback_failed");
    const events = store.events("owner", task.id);
    expect(events.find((event) => event.kind === "callback_dispatch")?.detail).toBe(
      "POST https://era.example.com/discard",
    );
    expect(events.find((event) => event.kind === "callback_response")?.detail).toBe(
      "HTTP 200; callback_failed; TASK_NOT_FOUND; Publishing task does not exist",
    );
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("discard callbacks carry the actual decision reason alongside the configured product scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-")),
    { store, bot } = fixture();
  let received: Record<string, unknown> | undefined;
  const worker = new BotWorker(
    store,
    () => engine("discard"),
    root,
    async (_url, options) => {
      received = JSON.parse(options.body!);
      return { status: 200, type: "application/json", body: Buffer.from('{"success":true}') };
    },
  );
  try {
    const value = input();
    value.callbacks!.discard.body = { batchNo: "batch-1", itemNum: "item-1", discardReason: "Excluded category" };
    const task = store.submit(bot, value, "reason").task;
    worker.start();
    await until(() => store.task("owner", task.id).status === "discarded");
    expect(received).toEqual({
      batchNo: "batch-1",
      itemNum: "item-1",
      discardReason: "Excluded category",
      reason: "Product evidence",
    });
    expect(store.task("owner", task.id).input.callbacks!.discard.body).not.toHaveProperty("reason");
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects private, loopback, mapped IPv6 and reserved destinations", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    expect(publicBotAddress(ip)).toBe(false);
  expect(publicBotAddress("8.8.8.8")).toBe(true);
  expect(publicBotAddress("2606:4700:4700::1111")).toBe(true);
});

test("dedicated bot sessions stay outside ordinary browser RPC, lists and notifications", async () => {
  const { ProjectDirectoryPolicy } = await import("../../src/server/projects/directory-policy.js");
  const policy = new ProjectDirectoryPolicy("/unused", true);
  policy.protectSessions((id) => id === "bot-session");
  await expect(policy.assertRequest("turn/start", { threadId: "bot-session" }, {}, async () => null)).rejects.toThrow();
  expect(
    await policy.list("thread/list", { data: [{ id: "bot-session" }, { id: "human-session" }] }, async () => null),
  ).toEqual({ data: [{ id: "human-session" }] });
  expect(
    policy.envelope({ method: "item/started", params: { threadId: "bot-session", item: { text: "private" } } }),
  ).toBe(false);
  expect(
    policy.event({
      type: "engine/notification",
      payload: { method: "turn/completed", params: { threadId: "bot-session" } },
    }),
  ).toBeNull();
  expect(policy.envelope({ method: "turn/completed", params: { threadId: "human-session" } })).toBe(true);
});

test("deleting a local task clears its content and history while retaining submission identity across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-delete-")),
    path = join(root, "bots.sqlite"),
    { store, bot } = fixture(path);
  try {
    const task = store.submit(bot, input(), "delete-test").task;
    expect(() => store.deleteTask("other", task.id)).toThrow("notFound");
    expect(store.tasks("owner")).toHaveLength(1);
    store.deleteTask("owner", task.id);
    expect(store.tasks("owner")).toEqual([]);
    expect(() => store.task("owner", task.id)).toThrow("notFound");
    expect(store.db.query("SELECT data,status FROM bot_tasks WHERE id=?").get(task.id)).toEqual({
      data: "{}",
      status: "deleted",
    });
    expect(
      store.db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM bot_events WHERE taskId=?").get(task.id)!.n,
    ).toBe(0);
    expect(() => store.submit(bot, input(), "delete-test")).toThrow("taskDeleted");
  } finally {
    store.close();
  }
  const reopened = new BotStore(path);
  try {
    expect(reopened.tasks("owner")).toEqual([]);
    expect(() => reopened.submit(bot, input(), "delete-test")).toThrow("taskDeleted");
    expect(reopened.submit(bot, input(), "new-test").duplicate).toBe(false);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("running tasks reject deletion and failed discard admission retains the review state", () => {
  const { store, bot } = fixture();
  try {
    const plain = botTaskInput({ ...input(), callbacks: undefined }),
      task = store.submit(bot, plain, "no-callback").task,
      claim = store.claim()!;
    expect(() => store.deleteTask("owner", task.id)).toThrow("taskRunning");
    expect(store.task("owner", task.id).status).toBe("running");
    claim.task.status = "review";
    store.update(claim.task, claim.lease, true);
    expect(() => store.review("owner", task.id, "discard")).toThrow("callbackRequired");
    expect(store.task("owner", task.id).status).toBe("review");
    expect(store.review("owner", task.id, "keep").status).toBe("kept");
    const callbackTask = store.submit(bot, input(), "old-domain").task,
      next = store.claim()!;
    next.task.status = "review";
    store.update(next.task, next.lease, true);
    store.updateBot("owner", bot.id, { callbackHosts: [] });
    expect(() => store.review("owner", callbackTask.id, "discard")).toThrow("callbackHostDenied");
    expect(store.task("owner", callbackTask.id).status).toBe("review");
  } finally {
    store.close();
  }
});

test("an explicitly reviewed discard runs for a paused bot without starting another model task", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-manual-discard-")),
    { store, bot } = fixture();
  let callbacks = 0,
    models = 0;
  const worker = new BotWorker(
    store,
    () => {
      models++;
      return engine("review");
    },
    root,
    async () => {
      callbacks++;
      return { status: 200, type: "application/json", body: Buffer.from('{"success":true}') };
    },
  );
  try {
    const task = store.submit(bot, input(), "reviewed").task,
      claim = store.claim()!;
    claim.task.status = "review";
    store.update(claim.task, claim.lease, true);
    store.updateBot("owner", bot.id, { active: false });
    const waiting = store.submit(bot, input(), "paused-model").task;
    store.review("owner", task.id, "discard");
    worker.tick();
    await until(() => store.task("owner", task.id).status === "discarded");
    expect(callbacks).toBe(1);
    expect(models).toBe(0);
    expect(store.task("owner", waiting.id).status).toBe("queued");
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("completion without a validated business decision is an execution Error", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-no-decision-")),
    { store, bot } = fixture();
  let callbacks = 0;
  const worker = new BotWorker(
    store,
    () => ({
      id: "fixture",
      async run() {
        return { sessionId: "empty", runId: "empty", status: "completed" };
      },
    }),
    root,
    async () => {
      callbacks++;
      throw new Error("Unexpected callback");
    },
  );
  try {
    const task = store.submit(bot, input(), "no-decision").task;
    worker.start();
    await until(() => store.task("owner", task.id).state === "error");
    expect(store.task("owner", task.id).decision).toBeNull();
    expect(callbacks).toBe(0);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
