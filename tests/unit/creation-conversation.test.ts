import { test, expect } from "bun:test";
import { JSDOM } from "jsdom";
import type { Translate } from "../../src/shared/i18n/messages.js";
import type { CreationTaskDetail } from "../../src/shared/creation/contracts.js";
import { creationConversation, previousCreationRounds } from "../../src/client/creation/activity-conversation.js";
globalThis.window = new JSDOM().window as unknown as Window & typeof globalThis;
const t = ((id: string) => id) as Translate;
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
test("the conversation shows real questions, answers and visible replies in time order without executing user markup", () => {
  const task = round("first");
  task.prompt = '<script>alert("input")</script>';
  task.progress = [
    { at: 2, generation: 1, stage: "message", text: "Preparing the outline" },
    { at: 8, generation: 1, stage: "message", text: "The editable result is saved" },
    { at: 4, generation: 1, stage: "saving" },
  ];
  task.clarifications = [
    {
      askedAt: 3,
      answeredAt: 5,
      questions: [{ id: "audience", question: "Who is this for?" }],
      answers: { audience: { answers: ["Operations"] } },
    },
  ];
  const view = new JSDOM(creationConversation([task], t)).window.document;
  expect(view.querySelector("script")).toBeNull();
  expect([...view.querySelectorAll(".creation-message > div")].map((node) => node.textContent?.trim())).toEqual([
    task.prompt,
    "Preparing the outline",
    "Who is this for?",
    "Operations",
    "The editable result is saved",
  ]);
  task.clarifications[0]!.questions[0]!.isSecret = true;
  expect(creationConversation([task], t)).not.toContain("Operations");
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
