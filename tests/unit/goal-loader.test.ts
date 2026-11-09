import { expect, test } from "bun:test";
import { createGoalLoader } from "../../src/client/goals/loader.js";

test("saved goals hydrate without notifications and concurrent reads share one native request", async () => {
  const applied: unknown[] = [],
    cleared: string[] = [];
  let calls = 0;
  const loader = createGoalLoader({
    rpc: async (method: string, params: { threadId: string }) => {
      calls++;
      expect(method).toBe("thread/goal/get");
      expect(params.threadId).toBe("thread-a");
      return { goal: { threadId: "thread-a", status: "paused", objective: "Keep the complete goal", tokensUsed: 21 } };
    },
    apply: (...args: unknown[]) => applied.push(args),
    clear: (id: string) => cleared.push(id),
  });
  await Promise.all([loader.load("thread-a"), loader.load("thread-a")]);
  expect(calls).toBe(1);
  expect(applied).toEqual([
    [
      "thread/goal/updated",
      {
        threadId: "thread-a",
        goal: { threadId: "thread-a", status: "paused", objective: "Keep the complete goal", tokensUsed: 21 },
      },
    ],
  ]);
  expect(cleared).toEqual([]);
});

test("late snapshots and absent snapshots cannot overwrite a newer live update or clear", async () => {
  const applied: unknown[] = [],
    cleared: string[] = [];
  let finish!: (value: unknown) => void;
  const loader = createGoalLoader({
    rpc: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    apply: (...args: unknown[]) => applied.push(args),
    clear: (id: string) => cleared.push(id),
  });
  const pending = loader.load("thread-a");
  await Promise.resolve();
  loader.changed("thread-a");
  finish({ goal: { threadId: "thread-a", status: "paused" } });
  await pending;
  expect(applied).toEqual([]);
  const second = loader.load("thread-a");
  await Promise.resolve();
  loader.changed("thread-a");
  finish({ goal: null });
  await second;
  expect(cleared).toEqual([]);
  const fresh = loader.load("thread-a");
  await Promise.resolve();
  finish({ goal: null });
  await fresh;
  expect(cleared).toEqual(["thread-a"]);
});

test("unsupported and cross-thread reads preserve the existing goal rather than inventing state", async () => {
  const applied: unknown[] = [],
    cleared: string[] = [],
    values = [
      {},
      { goal: { threadId: "other-thread", objective: "Other project", status: "active" } },
      { goal: "invalid" },
    ];
  const loader = createGoalLoader({
    rpc: async () => values.shift(),
    apply: (...args: unknown[]) => applied.push(args),
    clear: (id: string) => cleared.push(id),
  });
  await loader.load("thread-a");
  await loader.load("thread-a");
  await loader.load("thread-a");
  expect(applied).toEqual([]);
  expect(cleared).toEqual([]);
});
