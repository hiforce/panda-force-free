import { test, expect } from "bun:test";
import { CreationConversationHistory } from "../../src/client/creation/activity-conversation.js";
import { aggregateCreationActivity } from "../../src/client/creation/activity-model.js";
import type { CreationTaskDetail, CreationConversationPage } from "../../src/shared/creation/contracts.js";
const round = (index: number): CreationTaskDetail => ({
  id: "round-" + index,
  projectId: "personal",
  state: "succeeded",
  generation: 1,
  prompt: "Request " + index,
  model: "fixture",
  cancelRequested: false,
  artifact: null,
  failure: null,
  question: null,
  createdAt: index,
  updatedAt: index,
  progress: [],
  clarifications: [],
  ...(index ? { previousTaskId: "round-" + (index - 1) } : {}),
});
const page = (offset = 0): CreationConversationPage => ({
  creation: { id: "round-0", prompt: "Initial creation", createdAt: 0, rounds: 55 },
  latestTaskId: "round-54",
  ids: Array.from({ length: Math.min(10, 55 - offset) }, (_, i) => "round-" + (54 - offset - i)),
  nextCursor: offset + 10 < 55 ? String(offset + 10) : null,
});
test("one creation loads every earlier page with four bounded reads and reuses completed rounds", async () => {
  const history = new CreationConversationHistory(),
    cache = new Map(),
    signal = new AbortController().signal,
    current = round(54);
  let reads = 0,
    active = 0,
    peak = 0;
  const read = async (id: string) => {
    reads++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return { task: round(Number(id.slice(6))) };
  };
  let rounds = await history.load(page(), read, cache, current, signal);
  expect(rounds.length).toBe(10);
  expect(reads).toBe(9);
  expect(peak).toBe(4);
  await history.load(page(), read, cache, current, signal);
  expect(reads).toBe(9);
  for (let offset = 10; offset < 55; offset += 10)
    rounds = await history.load(page(offset), read, cache, current, signal, true);
  expect(rounds.map((r) => r.id)).toEqual(Array.from({ length: 55 }, (_, i) => "round-" + i));
  expect(history.nextCursor).toBeNull();
  expect(reads).toBe(54);
  await history.load(page(), read, cache, current, signal);
  expect(history.nextCursor).toBeNull();
  expect(reads).toBe(54);
});
test("an interrupted page keeps its cursor and a cancelled workspace never accepts late private details", async () => {
  const history = new CreationConversationHistory(),
    cache = new Map(),
    controller = new AbortController();
  let resolve!: (value: { task: CreationTaskDetail }) => void;
  const read = () => new Promise<{ task: CreationTaskDetail }>((r) => (resolve = r));
  const value = history.load({ ...page(), ids: ["round-1"] }, read, cache, round(54), controller.signal);
  controller.abort();
  resolve({ task: round(1) });
  await expect(value).rejects.toThrow();
  expect(cache.size).toBe(0);
  expect(history.page).toBeNull();
});
test("activity coalesces legacy continuations across asset changes while scopes and new creations remain separate", () => {
  const first = round(0),
    next = round(1),
    other = { ...round(2), previousTaskId: undefined };
  const result = aggregateCreationActivity([
    { scope: "personal", task: first },
    { scope: "personal", task: next },
    { scope: "personal", task: other },
    { scope: "application", task: first },
  ]);
  expect(result).toHaveLength(3);
  expect(result.some((row) => row.scope === "personal" && row.task.id === first.id)).toBe(false);
  const active = { ...next, state: "running" as const },
    latest = { ...round(3), creation: { id: first.id, prompt: "Initial", createdAt: 0, rounds: 3 } };
  expect(
    aggregateCreationActivity([
      { scope: "personal", task: { ...active, creation: latest.creation } },
      { scope: "personal", task: latest },
    ])[0]!.task.id,
  ).toBe(active.id);
});
