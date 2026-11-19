import { test, expect } from "bun:test";
import { BotStore } from "../../src/server/bots/store.js";
import { randomUUID } from "node:crypto";
const input = {
  externalTaskId: "same-business-product",
  instructions: "Independent task",
  input: { text: "Evidence", images: [] },
};

test("instance deletion is repeatable, fences delayed submission, and allows a regenerated instance", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "generic", name: "Worker" });
    const first = store.submit(bot, input, "instance-1").task;
    const deleted = store.bulkDelete("alice", { idempotencyKeys: ["instance-1", "delayed-instance"] }, bot.id);
    expect(deleted).toMatchObject({ deleted: 1, alreadyDeleted: 1, blocked: [] });
    expect(() => store.task("alice", first.id)).toThrow("notFound");
    expect(() => store.submit(bot, input, "instance-1")).toThrow("taskDeleted");
    expect(() => store.submit(bot, input, "delayed-instance")).toThrow("taskDeleted");
    const second = store.submit(bot, input, "instance-2");
    expect(second.duplicate).toBe(false);
    expect(second.task.id).not.toBe(first.id);
    expect(store.submit(bot, input, "instance-2").task.id).toBe(second.task.id);
    expect(store.bulkDelete("alice", { idempotencyKeys: ["instance-1"] }, bot.id).alreadyDeleted).toBe(1);
    expect(store.task("alice", second.task.id).status).toBe("queued");
  } finally {
    store.close();
  }
});

test("bulk deletion fences an active model lease without touching other owners or bot scopes", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "generic", name: "Worker" });
    const otherBot = store.createBot("alice", { code: "other", name: "Other" });
    const otherOwner = store.createBot("bob", { code: "generic", name: "Bob" });
    const a = store.submit(bot, input, "same-key").task;
    const b = store.submit(otherBot, input, "same-key").task;
    const c = store.submit(otherOwner, input, "same-key").task;
    const claimed = store.claim()!;
    expect(claimed.task.id).toBe(a.id);
    const result = store.bulkDelete("alice", { taskIds: [a.id, c.id, randomUUID()] });
    expect(result.deleted).toBe(1);
    expect(result.interrupted).toEqual([a.id]);
    expect(result.blocked.map((x) => x.code)).toEqual(["notFound", "notFound"]);
    expect(() => store.update(claimed.task, claimed.lease)).toThrow();
    expect(store.task("alice", b.id).status).toBe("queued");
    expect(store.task("bob", c.id).status).toBe("queued");
    store.bulkDelete("alice", { idempotencyKeys: ["same-key"] }, bot.id);
    expect(store.task("alice", b.id).status).toBe("queued");
  } finally {
    store.close();
  }
});

test("callbacks in flight remain visible and malformed selections make no changes", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "generic", name: "Worker", callbackHosts: ["callback.example"] });
    const { task } = store.submit(
      bot,
      {
        ...input,
        actions: [
          {
            id: "notify",
            label: "Notify",
            callback: { url: "https://callback.example/notify", method: "POST", body: {} },
          },
        ],
      },
      "notify-1",
    );
    const claimed = store.claim()!;
    claimed.task.decision = "notify";
    store.update(claimed.task, claimed.lease);
    expect(store.bulkDelete("alice", { taskIds: [task.id] }).blocked).toEqual([
      { id: task.id, code: "callbackInFlight" },
    ]);
    expect(store.task("alice", task.id).status).toBe("running");
    expect(() => store.bulkDelete("alice", { taskIds: [task.id, task.id] })).toThrow("invalidInput");
    expect(() => store.bulkDelete("alice", { taskIds: Array.from({ length: 501 }, () => randomUUID()) })).toThrow(
      "invalidInput",
    );
    expect(() => store.bulkDelete("alice", { idempotencyKeys: ["notify-1"] })).toThrow("invalidInput");
    expect(store.task("alice", task.id).status).toBe("running");
  } finally {
    store.close();
  }
});
