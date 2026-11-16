import { test, expect } from "bun:test";
import { BotStore } from "../../src/server/bots/store.js";
import { botTaskInput } from "../../src/shared/bots/contracts.js";
import { taskSummary } from "../../src/server/bots/task-title.js";

test("Bot task titles persist through submission, detail and summaries without changing legacy clients", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "task-title", name: "Reviewer" }),
      input = botTaskInput({
        title: "【预处理】品牌: VANS 货号: VN00H4XBA5 批次: batch-01",
        externalTaskId: "scope",
        instructions: "Review",
        input: { text: "Product evidence", images: [] },
      });
    const submitted = store.submit(bot, input, "same-key");
    expect(submitted.task.title).toBe(input.title);
    expect(store.task("alice", submitted.task.id).title).toBe(input.title);
    expect(store.taskSummaries("alice")[0]!.title).toBe(input.title);
    expect(store.submit(bot, input, "same-key").duplicate).toBe(true);
    expect(() => store.submit(bot, { ...input, title: "Changed title" }, "same-key")).toThrow("idempotencyConflict");
    const legacy = botTaskInput({
      externalTaskId: "old",
      instructions: "Review",
      input: { text: "Legacy product description", images: [] },
    });
    const task = store.submit(bot, legacy, "old").task;
    expect(task.title).toBeUndefined();
    expect(store.taskSummaries("alice").find((t) => t.id === task.id)!.summary).toBe("Legacy product description");
  } finally {
    store.close();
  }
});
test("title input is bounded and content fallback never rewrites stored historical records", () => {
  const input = { externalTaskId: "scope", instructions: "Review", input: { text: "Evidence" } };
  expect(() => botTaskInput({ ...input, title: " " })).toThrow("invalidInput");
  expect(() => botTaskInput({ ...input, title: "x".repeat(241) })).toThrow("invalidInput");
  expect(botTaskInput({ ...input, title: "  Review product  " }).title).toBe("Review product");
  const legacy = {
    id: "id",
    botId: "bot",
    externalTaskId: "external",
    status: "kept" as const,
    summary: JSON.stringify({ title: "Readable product name", description: "Details" }),
    reason: null,
    createdAt: 1,
    updatedAt: 2,
  };
  expect(taskSummary(legacy).summary).toBe("Readable product name");
  expect(legacy.summary.startsWith("{")).toBe(true);
});

test("legacy structured task content extracts a readable nested product summary", () => {
  const task = {
    id: "id",
    botId: "bot",
    externalTaskId: "external",
    status: "kept" as const,
    summary: JSON.stringify({
      externalTaskId: "long-machine-id",
      products: [{ title: "RAB Talus Windstopper Tight", description: "Product evidence" }],
    }),
    reason: null,
    createdAt: 1,
    updatedAt: 2,
  };
  expect(taskSummary(task).summary).toBe("RAB Talus Windstopper Tight");
});
