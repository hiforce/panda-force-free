import { expect, test } from "bun:test";
import { creationRoundItems } from "../../src/client/creation/session-projection.js";
import { CreationSessionReader } from "../../src/client/creation/session-reader.js";
import { CreationSessionState } from "../../src/client/creation/session-state.js";
import { creationApiFor } from "../../src/client/creation/api.js";
import type { CreationTaskDetail } from "../../src/shared/creation/contracts.js";
import type { Translate } from "../../src/shared/i18n/messages.js";
const task = (): CreationTaskDetail => ({
  id: "round",
  projectId: "personal",
  state: "running",
  generation: 1,
  prompt: "Request",
  model: "fixture",
  cancelRequested: false,
  artifact: null,
  failure: null,
  question: null,
  createdAt: 1000,
  updatedAt: 2000,
  progress: [],
  clarifications: [],
});
const t: Translate = (id) => id;

test("conversation projection preserves ordering, stable identities, delivery status and private answers", () => {
  const round = task();
  round.progress = [{ id: "stream", at: 1500, stage: "message", text: "Streaming", streaming: true, generation: 1 }];
  round.messages = [
    {
      id: "update",
      text: "Continue",
      state: "uncertain",
      createdAt: 1400,
      updatedAt: 1400,
      selections: [],
      attachments: [],
    },
  ];
  round.clarifications = [
    {
      askedAt: 1600,
      answeredAt: 1700,
      questions: [{ id: "secret", header: "Secret", question: "Password?", isSecret: true }],
      answers: { secret: { answers: ["DO_NOT_DISCLOSE"] } },
    },
  ];
  const first = creationRoundItems(round, t),
    second = creationRoundItems(round, t);
  expect(second).toEqual(first);
  expect(first.request.id).toBe("creation-round-request");
  expect(first.entries.map((e) => e.at)).toEqual([1400, 1500, 1600, 1700]);
  expect(first.entries[0]!.item.delivery).toBe("unconfirmed");
  expect(first.entries[1]!.item.status).toBe("inProgress");
  expect(JSON.stringify(first)).not.toContain("DO_NOT_DISCLOSE");
  round.state = "succeeded";
  expect(creationRoundItems(round, t).entries[1]!.item.status).toBe("completed");
});

for (const transition of ["route", "goal"] as const)
  test(`a late creation read cannot replace a newer ${transition}`, async () => {
    const state = new CreationSessionState();
    state.route = { id: "round", scope: "personal", key: "creation:personal:round" };
    let complete!: (value: { task: CreationTaskDetail }) => void,
      reads = 0,
      paints = 0,
      caches = 0;
    const pending = new Promise<{ task: CreationTaskDetail }>((resolve) => (complete = resolve));
    const api = {
      ...creationApiFor("personal"),
      rounds: async () => ({
        ids: ["round"],
        latestTaskId: "round",
        creation: { id: "round", prompt: "Request", createdAt: 1000, rounds: 1 },
        nextCursor: null,
      }),
      detail: () => {
        reads++;
        return pending;
      },
    };
    const reader = new CreationSessionReader(state, {
      api: () => api,
      present: () => paints++,
      cache: () => caches++,
      paintEarlier: () => {},
      hidden: () => false,
      failed: (error) => {
        throw error;
      },
    });
    const reading = reader.refresh();
    await Promise.resolve();
    await reader.refresh();
    expect(reads).toBe(1);
    if (transition === "route") state.epoch++;
    else state.goalRevision++;
    complete({ task: task() });
    await reading;
    expect(paints).toBe(0);
    expect(caches).toBe(0);
    if (transition === "route") expect(state.timer).toBeUndefined();
    clearTimeout(state.timer);
  });
