import { test, expect } from "bun:test";
import type { CreationTaskDetail } from "../../src/shared/creation/contracts.js";
import { previousCreationRounds } from "../../src/client/creation/activity-conversation.js";
const round = (id: string, previousTaskId?: string): CreationTaskDetail => ({
  id,
  projectId: "personal",
  state: "succeeded",
  generation: 1,
  prompt: "Original brief",
  model: "fixture",
  cancelRequested: false,
  artifact: null,
  failure: null,
  question: null,
  createdAt: 1,
  updatedAt: 5,
  progress: [],
  clarifications: [],
  ...(previousTaskId ? { previousTaskId } : {}),
});
test("linked output rounds are read oldest first and the bounded cache does not grow with repeated navigation", async () => {
  const tasks = new Map([
      ["one", round("one")],
      ["two", round("two", "one")],
    ]),
    cache = new Map();
  let reads = 0;
  const read = async (id: string) => {
    reads++;
    const task = tasks.get(id);
    if (!task) throw new Error("notFound");
    return { task };
  };
  expect((await previousCreationRounds(round("three", "two"), read, cache)).map((task) => task.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
  await previousCreationRounds(round("three", "two"), read, cache);
  expect(reads).toBe(2);
  await expect(previousCreationRounds(round("foreign", "missing"), read, cache)).rejects.toThrow("notFound");
});
