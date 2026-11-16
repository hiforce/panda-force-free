import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { botTaskInput, type BotAction, type BotReviewAnswer } from "../../src/shared/bots/contracts.js";
import { botTaskActions, botTaskAction, botTaskReview, botReviewProposal } from "../../src/shared/bots/actions.js";
import { transitionBotTask } from "../../src/server/bots/task-lifecycle.js";

const request = (actions?: unknown) => ({
  externalTaskId: "review-fixture",
  instructions: "Ask for clarification when evidence is incomplete.",
  input: { text: "A caller-defined independent task.", images: [] },
  ...(actions === undefined ? {} : { actions }),
});
const callback = () => ({
  url: "https://api.example.test/publish",
  method: "POST" as const,
  body: { taskId: "review-fixture", nested: { revision: 1 } },
  success: { path: "result.accepted", equals: true },
});
const actions = (): BotAction[] => [
  { id: "approve", label: "Approve the result", when: "The evidence is sufficient." },
  { id: "publish", label: "Publish the result", callback: callback() },
];
const proposal = () => ({
  question: "What should happen next?",
  options: [
    { id: "approved", label: "Accept this result", actionId: "approve" },
    { id: "send", label: "Send the approved result", actionId: "publish" },
    { id: "clarify", label: "Investigate the evidence further" },
  ],
});

test("review audit bounds retain the full answer within the MySQL event text limit", () => {
  const f = fixture();
  try {
    const question = "\u0001".repeat(4000),
      message = "\u0002".repeat(4000);
    const task = waiting(f, botTaskInput(request()), {
      question,
      options: Array.from({ length: 6 }, (_, i) => ({ id: "choice_" + i, label: "\u0003".repeat(240) })),
    });
    expect(() => f.store.review("owner", task.id, { reviewId: task.review!.id, message: message + "x" })).toThrow(
      "invalidInput",
    );
    f.store.review("owner", task.id, { reviewId: task.review!.id, message });
    const event = f.store.events("owner", task.id).find((item) => item.kind === "manual")!;
    expect(Buffer.byteLength(event.detail)).toBeLessThan(65535);
    expect(JSON.parse(event.detail)).toMatchObject({ review: { question }, answer: { message } });
  } finally {
    f.store.close();
  }
});
function fixture(path = ":memory:") {
  const store = new BotStore(path),
    bot = store.createBot("owner", {
      code: "generic-review",
      name: "Generic review",
      callbackHosts: ["api.example.test"],
    });
  return { store, bot };
}
function waiting(
  f: ReturnType<typeof fixture>,
  input = botTaskInput(request(actions())),
  review: unknown = proposal(),
) {
  const submitted = f.store.submit(f.bot, input, randomUUID()).task,
    claimed = f.store.claim()!;
  expect(claimed.task.id).toBe(submitted.id);
  const task = claimed.task;
  task.status = "review";
  task.decision = "review";
  task.reason = "Evidence requires an explicit answer.";
  task.sessionId = "saved-session";
  task.runId = "saved-run";
  task.review = { id: randomUUID(), ...botReviewProposal(review, task) };
  f.store.update(task, claimed.lease, true);
  return f.store.task("owner", task.id);
}

test("task actions preserve caller authority and reject ambiguous IDs, missing labels and mixed legacy callbacks", () => {
  const supplied = actions(),
    parsed = botTaskInput(request(supplied));
  supplied[1]!.callback!.url = "https://other.example.test/changed";
  (supplied[1]!.callback!.body.nested as { revision: number }).revision = 9;
  expect(parsed.actions![1]!.callback).toEqual(callback());
  expect(botTaskInput(request([{ id: "a".repeat(64), label: "Longest allowed action" }])).actions![0]!.id).toHaveLength(
    64,
  );
  const invalid = [
    ...["", "Uppercase", "a".repeat(65), "complete", "review", "cancel", "retry", "suspend", "resume"].map((id) => [
      { id, label: "Invalid action" },
    ]),
    [
      { id: "same", label: "First" },
      { id: "same", label: "Second" },
    ],
    [{ id: "missing_label" }],
    [{ id: "blank_label", label: "  " }],
    [{ id: "missing_callback_authority", label: "Send", url: "https://api.example.test/hidden" }],
    Array.from({ length: 17 }, (_, index) => ({ id: "action_" + index, label: "Too many actions" })),
    [{ id: "get", label: "Wrong method", callback: { ...callback(), method: "GET" } }],
    [{ id: "http", label: "Unencrypted endpoint", callback: { ...callback(), url: "http://api.example.test/plain" } }],
  ];
  for (const value of invalid) expect(() => botTaskInput(request(value))).toThrow();
  for (const value of [[], actions()])
    expect(() => botTaskInput({ ...request(value), callbacks: { discard: callback() } })).toThrow();
  const withoutActions = botTaskInput(request());
  expect(Object.hasOwn(withoutActions, "actions")).toBe(false);
  expect(botTaskActions({ input: withoutActions })).toEqual([]);
});

test("model review proposals can reference only declared actions and cannot introduce callback data", () => {
  const task = { input: botTaskInput(request(actions())) },
    raw = proposal(),
    parsed = botReviewProposal(raw, task);
  expect(parsed.options[1]).toMatchObject({ id: "send", actionId: "publish" });
  expect(parsed.options[2]).toEqual({ id: "clarify", label: "Investigate the evidence further" });
  raw.options[0]!.label = "Changed after validation";
  expect(parsed.options[0]!.label).toBe("Accept this result");
  for (const extra of [
    { callback: callback() },
    { url: callback().url },
    { body: {} },
    { method: "POST" },
    { success: { path: "ok", equals: true } },
  ]) {
    expect(() => botReviewProposal({ ...proposal(), ...extra }, task)).toThrow();
    expect(() =>
      botReviewProposal(
        { ...proposal(), options: [{ ...proposal().options[0], ...extra }, proposal().options[1]] },
        task,
      ),
    ).toThrow();
  }
  for (const value of [
    { ...proposal(), options: [{ id: "x", label: "Unauthorized", actionId: "not_declared" }, proposal().options[1]] },
    { ...proposal(), options: [{ id: "x", label: "Reserved", actionId: "complete" }, proposal().options[1]] },
    { ...proposal(), options: [proposal().options[0], proposal().options[0]] },
    { ...proposal(), options: [] },
    { ...proposal(), options: [proposal().options[0]] },
    {
      ...proposal(),
      options: Array.from({ length: 7 }, (_, index) => ({ id: "choice_" + index, label: "Too many choices" })),
    },
    { ...proposal(), question: " " },
    { ...proposal(), options: [{ id: "empty_label", label: " " }, proposal().options[1]] },
  ])
    expect(() => botReviewProposal(value, task)).toThrow();
  const generic = { input: botTaskInput(request()) };
  for (const id of ["keep", "discard"])
    expect(() =>
      botReviewProposal(
        {
          question: "Choose",
          options: [
            { id: "first", label: "Undeclared", actionId: id },
            { id: "second", label: "Explain" },
          ],
        },
        generic,
      ),
    ).toThrow();
  expect(
    botReviewProposal(
      {
        question: "Which evidence?",
        options: [
          { id: "first", label: "Inspect the source" },
          { id: "second", label: "Ask the author" },
        ],
      },
      generic,
    ).options,
  ).toHaveLength(2);
});

test("submission clones authority, preserves request fingerprints and checks current callback permissions", () => {
  const f = fixture();
  try {
    const input = botTaskInput(request(actions())),
      idempotency = "immutable-action",
      submitted = f.store.submit(f.bot, input, idempotency).task;
    (input.actions![1]!.callback!.body.nested as { revision: number }).revision = 99;
    expect(botTaskAction(f.store.task("owner", submitted.id), "publish")!.callback).toEqual(callback());
    expect(f.store.submit(f.bot, botTaskInput(request(actions())), idempotency).duplicate).toBe(true);
    expect(() => f.store.submit(f.bot, input, idempotency)).toThrow("idempotencyConflict");
    f.store.updateBot("owner", f.bot.id, { callbackHosts: [] });
    expect(() => f.store.submit(f.bot, botTaskInput(request(actions())), "revoked")).toThrow("callbackHostDenied");
    expect(f.store.tasks("owner")).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test("caller-defined keep and discard actions use generic completion semantics", () => {
  for (const actionId of ["keep", "discard"]) {
    const f = fixture();
    try {
      const task = waiting(f, botTaskInput(request([{ id: actionId, label: "Archive this local result" }])), {
        question: "Archive or investigate?",
        options: [
          { id: "archive", label: "Archive locally", actionId },
          { id: "continue", label: "Investigate further" },
        ],
      });
      expect(f.store.review("owner", task.id, { reviewId: task.review!.id, optionId: "archive" })).toMatchObject({
        status: "completed",
        decision: actionId,
        decisionLabel: "Archive this local result",
        callbackStatus: "not-required",
      });
      expect(
        f.store.queue("owner", { page: 1, anchor: 0, limit: 50, filter: "completed", botId: "", search: "" }).tasks[0],
      ).toMatchObject({ id: task.id, state: "finished", decisionLabel: "Archive this local result" });
    } finally {
      f.store.close();
    }
  }
});

test("generic mapped completion keeps its decision and an exact review receipt without legacy PIM statuses", () => {
  const f = fixture();
  try {
    const task = waiting(f),
      answer = { reviewId: task.review!.id, optionId: "approved" },
      result = f.store.review("owner", task.id, answer);
    expect(result).toMatchObject({
      status: "completed",
      state: "finished",
      decision: "approve",
      callbackStatus: "not-required",
    });
    expect(result.review).toBeUndefined();
    expect(result.reviewHistory).toHaveLength(1);
    expect(result.reviewHistory![0]).toMatchObject({ id: answer.reviewId, answer: { optionId: "approved" } });
    expect(f.store.review("owner", task.id, answer)).toEqual(result);
    expect(f.store.events("owner", task.id).filter((event) => event.kind === "manual")).toHaveLength(1);
    expect(() => f.store.review("owner", task.id, { ...answer, optionId: "send" })).toThrow();
    expect(f.store.task("owner", task.id)).toEqual(result);
  } finally {
    f.store.close();
  }
});

test("a mapped callback is pinned to its declared action and exact replays cannot reopen or fence a running callback", () => {
  const f = fixture();
  try {
    const task = waiting(f),
      answer = { reviewId: task.review!.id, optionId: "send" },
      queued = f.store.review("owner", task.id, answer);
    expect(queued).toMatchObject({ status: "queued", decision: "publish", callbackStatus: "pending" });
    expect(botTaskAction(queued, queued.decision)?.callback).toEqual(callback());
    const running = f.store.claim()!;
    expect(running.task.id).toBe(task.id);
    expect(f.store.review("owner", task.id, answer).status).toBe("running");
    expect(f.store.heartbeat(task.id, running.lease)).toBe(true);
    expect(f.store.task("owner", task.id).reviewHistory).toHaveLength(1);
    expect(f.store.events("owner", task.id).filter((event) => event.kind === "manual")).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test("unmapped answers and qualifying notes continue the engine without retaining a previous action decision", () => {
  for (const answer of [
    { optionId: "clarify" },
    { message: "Check the original evidence before deciding." },
    { optionId: "send", message: "Only send after checking the final amount." },
  ]) {
    const f = fixture();
    try {
      const task = waiting(f),
        queued = f.store.review("owner", task.id, { reviewId: task.review!.id, ...answer });
      expect(queued).toMatchObject({
        status: "queued",
        decision: null,
        callbackStatus: "not-required",
        sessionId: "saved-session",
        runId: null,
      });
      expect(queued.review).toBeUndefined();
      expect(queued.reviewHistory![0]!.answer).toMatchObject(answer);
      expect(botTaskAction(queued, queued.decision)?.callback).toBeUndefined();
      expect(f.store.claim()!.task.decision).toBeNull();
    } finally {
      f.store.close();
    }
  }
});

test("stale, cross-owner and forged choices leave the pending review and its event trail unchanged", () => {
  const f = fixture();
  try {
    const task = waiting(f),
      reviewId = task.review!.id,
      before = f.store.task("owner", task.id),
      events = f.store.events("owner", task.id);
    const invalid: unknown[] = [
      { reviewId: randomUUID(), optionId: "send" },
      { reviewId, optionId: "not_a_member" },
      { reviewId },
      { reviewId, message: " " },
      { reviewId, optionId: "send", actionId: "approve" },
      { reviewId, optionId: "send", callback: callback() },
    ];
    for (const value of invalid) expect(() => f.store.review("owner", task.id, value as BotReviewAnswer)).toThrow();
    expect(() => f.store.review("another-owner", task.id, { reviewId, optionId: "send" })).toThrow();
    expect(f.store.task("owner", task.id)).toEqual(before);
    expect(f.store.events("owner", task.id)).toEqual(events);
    f.store.updateBot("owner", f.bot.id, { callbackHosts: [] });
    expect(() => f.store.review("owner", task.id, { reviewId, optionId: "send" })).toThrow("callbackHostDenied");
    expect(f.store.task("owner", task.id)).toEqual(before);
  } finally {
    f.store.close();
  }
});

test("a replay of an earlier answer cannot answer a newer question", () => {
  const f = fixture();
  try {
    const task = waiting(f),
      firstAnswer = { reviewId: task.review!.id, optionId: "clarify" };
    f.store.review("owner", task.id, firstAnswer);
    const claimed = f.store.claim()!,
      newer = claimed.task;
    newer.status = "review";
    newer.decision = "review";
    newer.review = { id: randomUUID(), ...botReviewProposal(proposal(), newer) };
    f.store.update(newer, claimed.lease, true);
    const before = f.store.task("owner", task.id);
    expect(before).toEqual(f.store.review("owner", task.id, firstAnswer));
    expect(() => f.store.review("owner", task.id, { ...firstAnswer, optionId: "send" })).toThrow();
    expect(f.store.task("owner", task.id)).toEqual(before);
    expect(f.store.review("owner", task.id, { reviewId: newer.review.id, optionId: "approved" }).status).toBe(
      "completed",
    );
  } finally {
    f.store.close();
  }
});

test("known generic callback decisions recover as unknown and remain available for manual dispatch when a bot is inactive", () => {
  const f = fixture();
  try {
    const task = waiting(f);
    f.store.review("owner", task.id, { reviewId: task.review!.id, optionId: "send" });
    f.store.updateBot("owner", f.bot.id, { active: false });
    const running = f.store.claim()!;
    expect(running.task).toMatchObject({ id: task.id, decision: "publish" });
    f.store.db.query("UPDATE bot_tasks SET leaseUntil=0 WHERE id=?").run(task.id);
    expect(f.store.claim()).toBeNull();
    expect(f.store.task("owner", task.id)).toMatchObject({
      status: "callback_unknown",
      decision: "publish",
      callbackStatus: "unknown",
    });
    expect(() => f.store.update(running.task, running.lease, true)).toThrow("leaseLost");
    expect(() => f.store.review("owner", task.id, "discard")).toThrow();
    const retry = f.store.review("owner", task.id, "publish");
    expect(retry).toMatchObject({ status: "queued", decision: "publish", callbackStatus: "pending" });
    expect(botTaskAction(retry, retry.decision)?.callback).toEqual(callback());
    expect(() => f.store.review("owner", task.id, "discard")).toThrow();
  } finally {
    f.store.close();
  }
});

test("generic callback uncertainty and in-flight delivery retain lifecycle fences", () => {
  const f = fixture();
  try {
    const task = waiting(f),
      queued = f.store.review("owner", task.id, { reviewId: task.review!.id, optionId: "send" }),
      running = f.store.claim()!.task;
    for (const action of ["cancel", "suspend"] as const)
      expect(() => transitionBotTask(structuredClone(running), action)).toThrow("callbackInFlight");
    const unknown = { ...running, status: "callback_unknown" as const };
    for (const action of ["cancel", "suspend", "resume"] as const)
      expect(() => transitionBotTask(structuredClone(unknown), action)).toThrow("callbackInFlight");
    const suspended = transitionBotTask(structuredClone(queued), "suspend");
    expect(transitionBotTask(suspended, "resume")).toMatchObject({
      status: "queued",
      decision: "publish",
      callbackStatus: "pending",
    });
  } finally {
    f.store.close();
  }
});

test("legacy review IDs survive reopening while legacy callbacks retain their compatibility action list", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-review-legacy-")),
    path = join(root, "tasks.sqlite");
  let f = fixture(path);
  try {
    const task = f.store.submit(
        f.bot,
        botTaskInput({ ...request(), callbacks: { discard: callback() } }),
        "legacy",
      ).task,
      running = f.store.claim()!;
    running.task.status = "review";
    running.task.decision = "review";
    running.task.reason = "An existing legacy task needs review.";
    f.store.update(running.task, running.lease, true);
    const review = botTaskReview(f.store.task("owner", task.id));
    expect(botTaskActions(task).map((action) => action.id)).toEqual(["keep", "discard"]);
    expect(botTaskReview({ ...f.store.task("owner", task.id), id: randomUUID() }).id).not.toBe(review.id);
    f.store.close();
    const store = new BotStore(path);
    f = { store, bot: store.bot("owner", f.bot.id) };
    expect(botTaskReview(f.store.task("owner", task.id))).toEqual(review);
    expect(f.store.review("owner", task.id, "keep").status).toBe("kept");
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
