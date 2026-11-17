import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { botTaskInput, type BotAction, type BotReview } from "../../src/shared/bots/contracts.js";
import type { ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";

type RunInput = Parameters<ApplicationToolEngine["run"]>[0];
type RunCallbacks = Parameters<ApplicationToolEngine["run"]>[1];
type Proposal = { decision: string; reason: string; review?: Omit<BotReview, "id"> };
const owner = "review-owner",
  host = "review-hooks.example.test";
const declaredActions = (): BotAction[] => [
  { id: "save-draft", label: "Save the draft", when: "No external notification is needed." },
  {
    id: "notify-owner",
    label: "Notify the owner",
    when: "The reviewed evidence is sufficient.",
    callback: {
      url: `https://${host}/notify`,
      method: "POST",
      body: { externalId: "source-41", revision: 4 },
      success: { path: "result.accepted", equals: true },
    },
  },
];
const request = (actions?: BotAction[]) =>
  botTaskInput({
    externalTaskId: randomUUID(),
    instructions: "Resolve this independent request. Ask for a human choice when evidence is incomplete.",
    input: { text: "Two sources disagree about the next step.", images: [] },
    ...(actions === undefined ? {} : { actions }),
  });
const question = (text = "Which source should I examine?"): Omit<BotReview, "id"> => ({
  question: text,
  options: [
    { id: "primary", label: "Examine the primary source" },
    { id: "secondary", label: "Examine the secondary source" },
  ],
});
const mappedQuestion = (): Omit<BotReview, "id"> => ({
  question: "What should happen to the reviewed result?",
  options: [
    { id: "save", label: "Keep a local draft", actionId: "save-draft" },
    { id: "notify", label: "Notify the owner now", actionId: "notify-owner" },
    { id: "clarify", label: "Check the evidence again" },
  ],
});
const accepted = () => ({ status: 200, type: "application/json", body: Buffer.from('{"result":{"accepted":true}}') });
async function until(read: () => boolean) {
  const deadline = performance.now() + 6000;
  while (!read()) {
    if (performance.now() > deadline) throw Error("Bot review fixture timed out");
    await Bun.sleep(5);
  }
}

async function fixture(
  script: (input: RunInput, callbacks: RunCallbacks, index: number) => Promise<Proposal | void>,
  send?: ConstructorParameters<typeof BotWorker>[3],
) {
  const root = await mkdtemp(join(tmpdir(), "bot-review-worker-")),
    store = new BotStore(":memory:"),
    bot = store.createBot(owner, { code: "independent-review", name: "Independent review", callbackHosts: [host] }),
    inputs: RunInput[] = [];
  let networkCalls = 0;
  const worker = new BotWorker(
    store,
    () => ({
      id: "review-fixture",
      async run(input, callbacks) {
        inputs.push(input);
        const index = inputs.length - 1,
          sessionId = input.sessionId ?? "original-review-session",
          runId = "review-run-" + (index + 1);
        await callbacks.session?.(sessionId);
        await callbacks.started({ sessionId, runId });
        const decision = await script(input, callbacks, index);
        if (decision)
          await callbacks.call({
            sessionId,
            runId,
            callId: "decision-" + index,
            name: "panda_bot_decide",
            arguments: { taskId: JSON.parse(input.prompt).taskId, ...decision },
          });
        return { sessionId, runId, status: "completed" };
      },
    }),
    root,
    async (...args) => {
      networkCalls++;
      if (!send) throw Error("Unexpected network dispatch");
      return send(...args);
    },
  );
  return {
    store,
    bot,
    worker,
    inputs,
    get networkCalls() {
      return networkCalls;
    },
    submit(actions?: BotAction[]) {
      return store.submit(bot, request(actions), randomUUID()).task;
    },
    async close() {
      await worker.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("tasks without declared actions can ask multiple changing questions and continue the original conversation", async () => {
  const f = await fixture(async (_input, _callbacks, index) =>
    index < 2
      ? {
          decision: "review",
          reason: "The next step needs clarification.",
          review: question(index ? "What should the comparison emphasize?" : undefined),
        }
      : { decision: "complete", reason: "Compared the selected source and explained its uncertainty." },
  );
  try {
    const submitted = f.submit();
    await f.worker.tick();
    await until(() => !!f.store.task(owner, submitted.id).review);
    const first = f.store.task(owner, submitted.id),
      firstId = first.review!.id;
    expect(Object.hasOwn(first.input, "actions")).toBe(false);
    expect(Object.hasOwn(first.input, "callbacks")).toBe(false);
    expect(firstId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    expect(JSON.parse(f.inputs[0]!.prompt)).toMatchObject({ actions: [], reviewHistory: [] });
    const schema = f.inputs[0]!.tools.find((tool) => tool.name === "panda_bot_decide")!.inputSchema as {
      properties: { decision: { enum: string[] } };
    };
    expect(schema.properties.decision.enum).toEqual(["complete", "review"]);
    expect(f.inputs[0]!.instructions).not.toMatch(/\bproduct\b|\bclothing\b|\bfootwear\b|\bshoe\b/i);
    expect(f.inputs[0]!.instructions).toContain("The submitter defines the task domain");
    f.store.setSession(owner, f.bot.id, "newer-shared-bot-session");
    const answer = { reviewId: firstId, optionId: "primary" };
    expect(f.store.review(owner, submitted.id, answer)).toMatchObject({
      status: "queued",
      decision: null,
      sessionId: "original-review-session",
      runId: null,
    });
    await f.worker.tick();
    await until(
      () =>
        f.store.task(owner, submitted.id).review?.id !== undefined &&
        f.store.task(owner, submitted.id).review!.id !== firstId,
    );
    const second = f.store.task(owner, submitted.id);
    expect(second.review!.question).toBe("What should the comparison emphasize?");
    expect(second.review!.id).not.toBe(firstId);
    expect(f.inputs[1]!.sessionId).toBe("original-review-session");
    expect(JSON.parse(f.inputs[1]!.prompt).reviewHistory).toEqual([
      { ...first.review, answer: { optionId: "primary", at: expect.any(Number) } },
    ]);
    expect(second).toEqual(f.store.review(owner, submitted.id, answer));
    expect(() => f.store.review(owner, submitted.id, { ...answer, optionId: "secondary" })).toThrow("staleReview");
    await f.worker.tick();
    expect(f.inputs).toHaveLength(2);
    const message = "Prioritize the primary source and explain the remaining uncertainty.";
    f.store.review(owner, submitted.id, { reviewId: second.review!.id, message });
    await f.worker.tick();
    await until(() => f.store.task(owner, submitted.id).status === "completed");
    const complete = f.store.task(owner, submitted.id),
      history = JSON.parse(f.inputs[2]!.prompt).reviewHistory;
    expect(f.inputs[2]!.sessionId).toBe("original-review-session");
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ id: second.review!.id, question: second.review!.question, answer: { message } });
    expect(complete).toMatchObject({
      decision: "complete",
      state: "finished",
      callbackStatus: "not-required",
      sessionId: "original-review-session",
    });
    expect(complete.failure).toBeUndefined();
    expect(complete.review).toBeUndefined();
    expect(f.networkCalls).toBe(0);
    expect(f.store.events(owner, submitted.id).filter((event) => event.kind === "manual")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a declared local action completes directly from the human choice without another model run", async () => {
  const f = await fixture(async () => ({
    decision: "review",
    reason: "A choice is required.",
    review: mappedQuestion(),
  }));
  try {
    const task = f.submit(declaredActions());
    await f.worker.tick();
    await until(() => !!f.store.task(owner, task.id).review);
    const pending = f.store.task(owner, task.id),
      answer = { reviewId: pending.review!.id, optionId: "save" };
    expect(f.store.review(owner, task.id, answer)).toMatchObject({
      status: "completed",
      state: "finished",
      decision: "save-draft",
      decisionLabel: "Save the draft",
      callbackStatus: "not-required",
    });
    await f.worker.tick();
    expect(f.inputs).toHaveLength(1);
    expect(f.networkCalls).toBe(0);
    expect(f.store.review(owner, task.id, answer).status).toBe("completed");
  } finally {
    await f.close();
  }
});

test("legacy callback actions remain selectable through structured review and keep their original idempotency key", async () => {
  const keys: string[] = [];
  const f = await fixture(
    async () => ({
      decision: "review",
      reason: "Choose how to handle this legacy request.",
      review: {
        question: "Should the configured action run?",
        options: [
          { id: "retain", label: "Keep this request", actionId: "keep" },
          { id: "execute", label: "Run the configured action", actionId: "discard" },
        ],
      },
    }),
    async (_url, options) => {
      keys.push(options.headers!["idempotency-key"]!);
      return accepted();
    },
  );
  try {
    const task = f.store.submit(
      f.bot,
      botTaskInput({ ...request(), callbacks: { discard: declaredActions()[1]!.callback } }),
      randomUUID(),
    ).task;
    await f.worker.tick();
    await until(() => !!f.store.task(owner, task.id).review);
    const pending = f.store.task(owner, task.id);
    f.store.review(owner, task.id, { reviewId: pending.review!.id, optionId: "execute" });
    await f.worker.tick();
    await until(() => f.store.task(owner, task.id).status === "discarded");
    expect(f.store.task(owner, task.id)).toMatchObject({
      decision: "discard",
      callbackStatus: "succeeded",
      state: "finished",
    });
    expect(keys).toEqual(["panda-bot-" + task.id]);
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a note qualifying a mapped callback is interpreted by the model before any dispatch", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    sent: { url: string; key: string; body: unknown }[] = [];
  const f = await fixture(
    async (input, _callbacks, index) => {
      if (!index) return { decision: "review", reason: "Please confirm the next step.", review: mappedQuestion() };
      expect(JSON.parse(input.prompt).reviewHistory[0]).toMatchObject({
        answer: { optionId: "notify", message: "Validate the new amount before notifying anyone." },
      });
      entered();
      await blocked;
      return {
        decision: "notify-owner",
        reason: "Validated the revised amount and confirmed notification is permitted.",
      };
    },
    async (url, options) => {
      sent.push({ url, key: options.headers!["idempotency-key"]!, body: JSON.parse(options.body!) });
      return accepted();
    },
  );
  try {
    const task = f.submit(declaredActions());
    await f.worker.tick();
    await until(() => !!f.store.task(owner, task.id).review);
    const pending = f.store.task(owner, task.id),
      queued = f.store.review(owner, task.id, {
        reviewId: pending.review!.id,
        optionId: "notify",
        message: "Validate the new amount before notifying anyone.",
      });
    expect(queued).toMatchObject({ status: "queued", decision: null, callbackStatus: "not-required" });
    expect(sent).toEqual([]);
    await f.worker.tick();
    await started;
    expect(sent).toEqual([]);
    expect(f.inputs[1]!.sessionId).toBe("original-review-session");
    const prompt = JSON.parse(f.inputs[1]!.prompt);
    expect(prompt.actions).toEqual(declaredActions().map(({ id, label, when }) => ({ id, label, when })));
    expect(f.inputs[1]!.prompt).not.toContain(`https://${host}`);
    release();
    await until(() => f.store.task(owner, task.id).status === "completed");
    expect(f.store.task(owner, task.id)).toMatchObject({
      decision: "notify-owner",
      decisionLabel: "Notify the owner",
      callbackStatus: "succeeded",
    });
    expect(sent).toEqual([
      {
        url: `https://${host}/notify`,
        key: `panda-bot-${task.id}:notify-owner`,
        body: {
          externalId: "source-41",
          revision: 4,
          reason: "Validated the revised amount and confirmed notification is permitted.",
        },
      },
    ]);
  } finally {
    release();
    await f.close();
  }
});

for (const outcome of ["failed", "unknown"] as const)
  test(`declared callback ${outcome} waits for explicit retry of its prior action with a stable idempotency key`, async () => {
    const sent: { key: string; body: string }[] = [];
    const f = await fixture(
      async () => ({ decision: "review", reason: "Choose the permitted action.", review: mappedQuestion() }),
      async (_url, options) => {
        sent.push({ key: options.headers!["idempotency-key"]!, body: options.body! });
        if (sent.length === 1) {
          if (outcome === "unknown") throw Error("Acknowledgement was lost");
          return { status: 200, type: "application/json", body: Buffer.from('{"result":{"accepted":false}}') };
        }
        return accepted();
      },
    );
    try {
      const task = f.submit(declaredActions());
      await f.worker.tick();
      await until(() => !!f.store.task(owner, task.id).review);
      const pending = f.store.task(owner, task.id),
        answer = { reviewId: pending.review!.id, optionId: "notify" };
      f.store.review(owner, task.id, answer);
      await f.worker.tick();
      await until(() => f.store.task(owner, task.id).status === "callback_" + outcome);
      const failed = f.store.task(owner, task.id);
      expect(failed).toMatchObject({
        decision: "notify-owner",
        callbackStatus: outcome,
        decisionLabel: "Notify the owner",
      });
      expect(failed).toEqual(f.store.review(owner, task.id, answer));
      await f.worker.tick();
      await Bun.sleep(15);
      expect(sent).toHaveLength(1);
      expect(f.inputs).toHaveLength(1);
      expect(() => f.store.review(owner, task.id, "discard")).toThrow("invalidAction");
      f.store.review(owner, task.id, failed.decision!);
      await f.worker.tick();
      await until(() => f.store.task(owner, task.id).status === "completed");
      expect(f.inputs).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[0]!.key).toBe(`panda-bot-${task.id}:notify-owner`);
      expect(f.store.task(owner, task.id)).toMatchObject({
        decision: "notify-owner",
        callbackStatus: "succeeded",
        state: "finished",
      });
      expect(f.store.events(owner, task.id).filter((event) => event.kind === "callback_dispatch")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

for (const outcome of ["succeeded", "failed"] as const)
  test(`a callback response audit failure cannot downgrade a committed ${outcome} receipt`, async () => {
    const f = await fixture(
      async () => ({ decision: "notify-owner", reason: "The declared action is permitted." }),
      async () =>
        outcome === "succeeded"
          ? accepted()
          : { status: 200, type: "application/json", body: Buffer.from('{"result":{"accepted":false}}') },
    );
    const event = f.store.event.bind(f.store);
    const update = f.store.update.bind(f.store);
    let responseAuditFailures = 0,
      unknownWriteAttempts = 0;
    f.store.update = (...args) => {
      if (args[0].status === "callback_unknown") unknownWriteAttempts++;
      return update(...args);
    };
    f.store.event = (...args) => {
      if (args[1] === "callback_response") {
        responseAuditFailures++;
        throw Error("Audit storage unavailable after receipt commit");
      }
      return event(...args);
    };
    try {
      const task = f.submit(declaredActions());
      await f.worker.tick();
      await until(() => responseAuditFailures === 1);
      const status = outcome === "succeeded" ? "completed" : "callback_failed";
      expect(f.store.task(owner, task.id)).toMatchObject({ status, callbackStatus: outcome, decision: "notify-owner" });
      await f.worker.tick();
      await Bun.sleep(10);
      expect(f.store.task(owner, task.id)).toMatchObject({ status, callbackStatus: outcome });
      expect(f.networkCalls).toBe(1);
      expect(unknownWriteAttempts).toBe(0);
      expect(f.store.events(owner, task.id).filter((value) => value.kind === "callback_dispatch")).toHaveLength(1);
      expect(f.store.events(owner, task.id).some((value) => value.kind === "interrupted")).toBe(false);
    } finally {
      await f.close();
    }
  });

for (const [name, invalid] of [
  ["undeclared direct action", { decision: "invented-action", reason: "Send it." }],
  [
    "undeclared mapped action",
    {
      decision: "review",
      reason: "Choose it.",
      review: {
        question: "What next?",
        options: [
          { id: "unsafe", label: "Invent an action", actionId: "invented-action" },
          { id: "wait", label: "Wait" },
        ],
      },
    },
  ],
  [
    "model supplied endpoint",
    { decision: "notify-owner", reason: "Send it.", callback: { url: "https://untrusted.example.test/send" } },
  ],
  [
    "model supplied option endpoint",
    {
      decision: "review",
      reason: "Choose it.",
      review: {
        question: "What next?",
        options: [
          {
            id: "unsafe",
            label: "Use this endpoint",
            actionId: "notify-owner",
            callback: { url: "https://untrusted.example.test/send" },
          },
          { id: "wait", label: "Wait" },
        ],
      },
    },
  ],
] as const)
  test(`invalid model ${name} cannot grant callback authority`, async () => {
    let rejected = false;
    const f = await fixture(async (input, callbacks, index) => {
      try {
        await callbacks.call({
          sessionId: input.sessionId ?? "original-review-session",
          runId: "review-run-" + (index + 1),
          callId: "invalid",
          name: "panda_bot_decide",
          arguments: { taskId: JSON.parse(input.prompt).taskId, ...invalid },
        });
      } catch {
        rejected = true;
        throw Error("Rejected model proposal");
      }
    });
    try {
      const task = f.submit(declaredActions());
      await f.worker.tick();
      await until(() => f.store.task(owner, task.id).status === "review");
      const result = f.store.task(owner, task.id);
      expect(rejected).toBe(true);
      expect(result.decision).toBeNull();
      expect(result.failure).toBe("execution");
      expect(result.review).toBeUndefined();
      expect(f.networkCalls).toBe(0);
      expect(f.store.events(owner, task.id).some((event) => event.kind === "callback_dispatch")).toBe(false);
    } finally {
      await f.close();
    }
  });

test("caller-defined report actions complete with their own result labels and no product decisions", async () => {
  const f = await fixture(async () => ({
    decision: "archive-report",
    reason: "Archived the report with its supporting sources.",
  }));
  try {
    const task = f.submit([{ id: "archive-report", label: "Archive report", when: "The report is ready." }]);
    await f.worker.tick();
    await until(() => f.store.task(owner, task.id).status === "completed");
    const result = f.store.task(owner, task.id);
    expect(result.decision).toBe("archive-report");
    expect(result.decisionLabel).toBe("Archive report");
    expect(result.reason).toBe("Archived the report with its supporting sources.");
    const tool = f.inputs[0]!.tools.find((tool) => tool.name === "panda_bot_decide")!;
    expect((tool.inputSchema as { properties: { decision: { enum: string[] } } }).properties.decision.enum).toEqual([
      "complete",
      "review",
      "archive-report",
    ]);
    expect(f.networkCalls).toBe(0);
  } finally {
    await f.close();
  }
});
