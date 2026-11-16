import { test, expect } from "bun:test";
import { botTaskState, botTaskDecision, botCallbackStatus } from "../../src/shared/bots/task-state.js";
import { BotStore } from "../../src/server/bots/store.js";
import { changeBotTaskLifecycle } from "../../src/server/bots/task-lifecycle.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("finished execution is independent of keep/discard business results and callback acknowledgment", () => {
  expect(botTaskState({ status: "kept", decision: "keep" })).toBe("finished");
  expect(botTaskState({ status: "discarded", decision: "discard" })).toBe("finished");
  expect(botTaskDecision({ status: "discarded" })).toBe("discard");
  expect(botCallbackStatus({ status: "discarded", decision: "discard" })).toBe("succeeded");
  expect(botTaskState({ status: "queued" })).toBe("created");
  expect(botTaskState({ status: "running" })).toBe("running");
  expect(botTaskState({ status: "review", decision: "review" })).toBe("suspended");
  expect(botTaskState({ status: "review", failure: "execution" })).toBe("error");
  expect(botTaskState({ status: "callback_failed", decision: "discard" })).toBe("error");
  expect(botCallbackStatus({ status: "callback_failed", decision: "discard" })).toBe("failed");
  expect(botTaskState({ status: "callback_unknown", decision: "discard" })).toBe("suspended");
  expect(botTaskState({ status: "canceled" })).toBe("canceled");
});
test("pause, resume and cancel fence old leases and never trigger an external business action", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-bot-state-")),
    store = new BotStore(join(root, "bots.sqlite"));
  try {
    const bot = store.configureBot("owner", {
      code: "state-test",
      name: "State test",
      instructions: "Review supplied facts",
      callbackHosts: ["example.com"],
    });
    const first = store.submit(
      bot,
      { externalTaskId: "first", instructions: "Check", input: { text: "Test", images: [] } },
      "first",
    ).task;
    expect(first.state).toBe("created");
    const claim = store.claim()!;
    expect(claim.task.id).toBe(first.id);
    const paused = changeBotTaskLifecycle(store, "owner", first.id, "suspend");
    expect(paused.state).toBe("suspended");
    expect(paused.decision).toBeNull();
    expect(() => store.update({ ...claim.task, status: "kept", decision: "keep" }, claim.lease, true)).toThrow(
      "leaseLost",
    );
    expect(changeBotTaskLifecycle(store, "owner", first.id, "resume").state).toBe("created");
    const running = store.claim()!;
    const canceled = changeBotTaskLifecycle(store, "owner", first.id, "cancel");
    expect(canceled.state).toBe("canceled");
    expect(() =>
      store.update({ ...running.task, status: "discarded", decision: "discard" }, running.lease, true),
    ).toThrow("leaseLost");
    expect(changeBotTaskLifecycle(store, "owner", first.id, "cancel").state).toBe("canceled");
    expect(() => changeBotTaskLifecycle(store, "owner", first.id, "resume")).toThrow("invalidState");
    expect(() => changeBotTaskLifecycle(store, "other-owner", first.id, "cancel")).toThrow("notFound");
    const second = store.submit(
      bot,
      { externalTaskId: "second", instructions: "Check", input: { text: "Test", images: [] } },
      "second",
    ).task;
    expect(store.claim([bot.id])).toBeNull();
    expect(store.task("owner", second.id).state).toBe("created");
    const next = store.claim()!;
    next.task.decision = "discard";
    store.update(next.task, next.lease);
    expect(() => changeBotTaskLifecycle(store, "owner", second.id, "cancel")).toThrow("callbackInFlight");
    expect(store.task("owner", second.id).state).toBe("running");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired execution becomes Error while an uncertain callback remains Suspended", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.configureBot("owner", { name: "Recovery", code: "recovery", instructions: "Check" });
    const input = { externalTaskId: "recover-1", instructions: "Check", input: { text: "Sample", images: [] } };
    const first = store.submit(bot, input, "recover-1").task;
    store.claim();
    store.db.query("UPDATE bot_tasks SET leaseUntil=0 WHERE id=?").run(first.id);
    store.claim();
    expect(store.task("owner", first.id).state).toBe("error");
    const second = store.submit(bot, { ...input, externalTaskId: "recover-2" }, "recover-2").task;
    const claim = store.claim()!;
    claim.task.decision = "discard";
    store.update(claim.task, claim.lease);
    store.db.query("UPDATE bot_tasks SET leaseUntil=0 WHERE id=?").run(second.id);
    store.claim();
    expect(store.task("owner", second.id).state).toBe("suspended");
    expect(store.task("owner", second.id).callbackStatus).toBe("unknown");
  } finally {
    store.close();
  }
});

test("resuming a paused approved callback preserves the business decision", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.configureBot("owner", { name: "Approved", code: "approved", instructions: "Check" });
    const task = store.submit(
      bot,
      { externalTaskId: "approved", instructions: "Check", input: { text: "Sample", images: [] } },
      "approved",
    ).task;
    task.status = "suspended";
    task.decision = "discard";
    task.reason = "Owner approved the external action";
    store.db.query("UPDATE bot_tasks SET status=?,data=? WHERE id=?").run(task.status, JSON.stringify(task), task.id);
    const resumed = changeBotTaskLifecycle(store, "owner", task.id, "resume");
    expect(resumed.state).toBe("created");
    expect(resumed.decision).toBe("discard");
    expect(resumed.reason).toBe(task.reason);
  } finally {
    store.close();
  }
});
