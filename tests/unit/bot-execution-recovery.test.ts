import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { applicationRunFailure } from "../../src/shared/engine/application-failure.js";
import type { BotTask } from "../../src/shared/bots/contracts.js";

const input = () => ({
  externalTaskId: randomUUID(),
  instructions: "Inspect supplied evidence",
  input: { text: "Fixture evidence", images: [] },
});
function failed(
  store: BotStore,
  owner: string,
  botId: string,
  status: BotTask["status"] = "review",
  decision: string | null = null,
) {
  const task = store.submit(store.bot(owner, botId), input(), randomUUID()).task;
  Object.assign(task, {
    status,
    decision,
    failure: status === "review" ? "execution" : undefined,
    reason: "No validated decision was received",
  });
  store.db.query("UPDATE bot_tasks SET status=?,data=? WHERE id=?").run(status, JSON.stringify(task), task.id);
  return task;
}
test("quota classification accepts native spellings without exposing raw provider details", () => {
  expect(applicationRunFailure({ codex_error_info: "rate_limit_exceeded" })).toBe("rateLimited");
  expect(applicationRunFailure({ codexErrorInfo: "usageLimitExceeded" })).toBe("rateLimited");
  expect(applicationRunFailure({ codexErrorInfo: "unauthorized" })).toBe("authentication");
  expect(applicationRunFailure({ message: "private unrecognized provider text" })).toBe("failed");
});
test("bulk execution recovery keeps IDs, skips other states and owners, and survives lost acknowledgments and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-bulk-recovery-")),
    path = join(root, "tasks.sqlite");
  let store = new BotStore(path);
  try {
    const bot = store.createBot("alice", { code: "bulk-recovery", name: "Recovery" });
    const other = store.createBot("bob", { code: "bulk-recovery", name: "Other owner" });
    const first = failed(store, "alice", bot.id),
      second = failed(store, "alice", bot.id);
    const human = failed(store, "alice", bot.id, "review", "review"),
      callback = failed(store, "alice", bot.id, "callback_failed", "discard");
    const done = failed(store, "alice", bot.id, "completed", "complete"),
      foreign = failed(store, "bob", other.id);
    const request = { id: randomUUID(), taskIds: [first, second, human, callback, done, foreign].map((t) => t.id) };
    const receipt = store.retryFailed("alice", request);
    expect(receipt).toEqual({ id: request.id, requested: 6, queued: 2, skipped: 4 });
    for (const task of [first, second]) {
      const actual = store.task("alice", task.id);
      expect(actual).toMatchObject({ id: task.id, status: "queued", decision: null, input: task.input });
      expect(actual.failure).toBeUndefined();
      expect(store.events("alice", task.id).filter((event) => event.kind === "resume")).toHaveLength(1);
    }
    expect(store.task("bob", foreign.id).status).toBe("review");
    expect(store.task("alice", human.id).decision).toBe("review");
    expect(store.task("alice", callback.id).status).toBe("callback_failed");
    expect(() => store.retryFailed("alice", { ...request, taskIds: [first.id] })).toThrow("idempotencyConflict");
    // Simulate a later failed execution before the client replays an uncertain response.
    const changed = store.task("alice", first.id);
    Object.assign(changed, { status: "review", failure: "execution" });
    store.db.query("UPDATE bot_tasks SET status='review',data=? WHERE id=?").run(JSON.stringify(changed), changed.id);
    store.close();
    store = new BotStore(path);
    expect(store.retryFailed("alice", request)).toEqual(receipt);
    expect(store.task("alice", first.id).status).toBe("review");
    expect(store.events("alice", first.id).filter((event) => event.kind === "resume")).toHaveLength(1);
    expect(() => store.retryFailed("alice", { id: randomUUID(), taskIds: Array(501).fill(first.id) })).toThrow(
      "invalidInput",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a rate-limited Bot keeps its queue intact while other Bots run and its backoff survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-rate-limit-")),
    path = join(root, "tasks.sqlite");
  let store = new BotStore(path),
    runs = 0;
  const bot = store.createBot("alice", { code: "limited-bot", name: "Limited" });
  const other = store.createBot("alice", { code: "healthy-bot", name: "Healthy" });
  const first = store.submit(bot, input(), randomUUID()).task;
  const second = store.submit(bot, input(), randomUUID()).task;
  const healthy = store.submit(other, input(), randomUUID()).task;
  const worker = new BotWorker(
    store,
    (current) => ({
      id: "fixture",
      async run(value, callbacks) {
        runs++;
        const scope = { sessionId: current.id, runId: randomUUID() };
        await callbacks.session?.(scope.sessionId);
        await callbacks.started(scope);
        if (current.id === bot.id) return { ...scope, status: "failed", failure: "rateLimited" };
        await callbacks.call({
          ...scope,
          name: "panda_bot_decide",
          callId: randomUUID(),
          arguments: { taskId: JSON.parse(value.prompt).taskId, decision: "complete", reason: "Healthy fixture" },
        });
        return { ...scope, status: "completed" };
      },
    }),
    root,
    async () => {
      throw Error("No external callback is allowed");
    },
  );
  try {
    await worker.tick();
    const deadline = Date.now() + 4000;
    while (store.task("alice", healthy.id).status !== "completed") {
      if (Date.now() > deadline) throw Error("Recovery fixture timed out");
      await Bun.sleep(5);
    }
    expect(runs).toBe(2);
    expect(store.task("alice", first.id)).toMatchObject({ status: "queued", reason: "modelRateLimited" });
    expect(store.task("alice", second.id).status).toBe("queued");
    expect(store.queue("alice").counts.error ?? 0).toBe(0);
    expect(store.bot("alice", bot.id).executionRetryAt!).toBeGreaterThan(Date.now());
    await worker.close();
    store.close();
    store = new BotStore(path);
    expect(store.claim()).toBeNull();
    expect(store.queue("alice").counts.created).toBe(2);
    store.updateBot("alice", bot.id, { model: "available-fixture-model" });
    expect(store.claim()?.task.id).toBe(first.id);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
