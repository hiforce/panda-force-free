import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { BotStore } from "../../src/server/bots/store.js";
import { createRouter } from "../../src/server/http/router.js";
import { botTaskInput, type BotReview } from "../../src/shared/bots/contracts.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-review-api-")),
    store = new BotStore(":memory:"),
    owner = "alice",
    bot = store.createBot(owner, {
      code: "review-request",
      name: "Review request",
      callbackHosts: ["review-hooks.example.test"],
    });
  let engineRequests = 0;
  // API tests inspect admission only; worker execution and transport are covered by the mocked worker fixtures.
  const parked = new Proxy(store, {
    get(target, key) {
      if (key === "claim") return () => null;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const feature = createBotFeature({
      stateRoot: root,
      version: "test",
      connection: { mode: "isolated" },
      owner: (context) => String(context.req.headers["x-test-owner"] ?? owner),
      store: parked,
      engine: () => {
        engineRequests++;
        throw Error("API admission fixture must not execute a model");
      },
    }),
    dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      const context = { req, res, url: new URL(req.url!, "http://localhost") };
      void (async () => {
        if (await dispatch(context)) return;
        res.writeHead(404).end();
      })();
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (id: string, action: "review" | "retry", value: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/bots/tasks/" + id + "/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  const submit = () =>
    store.submit(
      bot,
      botTaskInput({
        externalTaskId: randomUUID(),
        instructions: "Ask for the next human choice.",
        input: { text: "Independent request", images: [] },
        actions: [
          { id: "save-draft", label: "Save the draft" },
          { id: "keep", label: "Keep the source" },
          {
            id: "notify-owner",
            label: "Notify the owner",
            callback: { url: "https://review-hooks.example.test/notify", method: "POST", body: { revision: 4 } },
          },
        ],
      }),
      randomUUID(),
    ).task;
  const review = (id: string, question = "Which evidence should I check?"): BotReview => ({
    id,
    question,
    options: [
      { id: "primary", label: "Check the primary source" },
      { id: "secondary", label: "Check the secondary source" },
      { id: "save", label: "Save a draft", actionId: "save-draft" },
    ],
  });
  function waiting() {
    const submitted = submit(),
      claim = store.claim()!;
    claim.task.status = "review";
    claim.task.decision = "review";
    claim.task.sessionId = "original-review-session";
    claim.task.runId = "original-review-run";
    claim.task.review = review(randomUUID());
    store.update(claim.task, claim.lease, true);
    return store.task(owner, submitted.id);
  }
  return {
    store,
    owner,
    bot,
    call,
    submit,
    review,
    waiting,
    get engineRequests() {
      return engineRequests;
    },
    async close() {
      await feature.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("review API enforces owner, origin, exact review choices and idempotent replay without fencing an active continuation", async () => {
  const f = await fixture();
  try {
    const task = f.waiting(),
      answer = { reviewId: task.review!.id, optionId: "primary" },
      before = f.store.task(f.owner, task.id);
    expect((await f.call(task.id, "review", answer, { "x-test-owner": "bob" })).status).toBe(404);
    expect((await f.call(task.id, "review", answer, { origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await f.call(task.id, "review", { reviewId: task.review!.id })).status).toBe(400);
    expect((await f.call(task.id, "review", { ...answer, optionId: "forged-option" })).status).toBe(400);
    expect((await f.call(task.id, "review", { ...answer, reviewId: randomUUID() })).status).toBe(409);
    expect((await f.call(task.id, "review", { ...answer, actionId: "notify-owner" })).status).toBe(400);
    const bypass = await f.call(task.id, "review", { decision: "keep" });
    expect(bypass.status).toBe(400);
    expect(bypass.value.error.code).toBe("invalidReview");
    expect(f.store.task(f.owner, task.id)).toEqual(before);
    expect(f.store.events(f.owner, task.id).filter((value) => value.kind === "manual")).toHaveLength(0);
    const queued = await f.call(task.id, "review", answer);
    expect(queued.status).toBe(200);
    expect(queued.value.task).toMatchObject({
      status: "queued",
      decision: null,
      sessionId: "original-review-session",
      runId: null,
    });
    const active = f.store.claim()!;
    expect(active.task.id).toBe(task.id);
    const replay = await f.call(task.id, "review", answer);
    expect(replay.status).toBe(200);
    expect(replay.value.task.status).toBe("running");
    expect(f.store.heartbeat(task.id, active.lease)).toBe(true);
    expect((await f.call(task.id, "review", { ...answer, optionId: "secondary" })).status).toBe(409);
    active.task.status = "review";
    active.task.decision = "review";
    active.task.review = f.review(randomUUID(), "Which comparison should I produce?");
    f.store.update(active.task, active.lease, true);
    const newer = f.store.task(f.owner, task.id),
      oldReplay = await f.call(task.id, "review", answer);
    expect(oldReplay.status).toBe(200);
    expect(oldReplay.value.task).toEqual(newer);
    const note = "Compare both sources and explain the disagreement.";
    const resumed = await f.call(task.id, "review", { reviewId: newer.review!.id, message: note });
    expect(resumed.status).toBe(200);
    expect(resumed.value.task.reviewHistory).toHaveLength(2);
    expect(resumed.value.task.reviewHistory[1].answer.message).toBe(note);
    expect(f.store.events(f.owner, task.id).filter((value) => value.kind === "manual")).toHaveLength(2);
    expect(f.engineRequests).toBe(0);
  } finally {
    await f.close();
  }
});

for (const outcome of ["failed", "unknown"] as const)
  test(`callback ${outcome} API retry requires confirmation and queues the same declared action`, async () => {
    const f = await fixture();
    try {
      const task = f.submit(),
        claim = f.store.claim()!;
      claim.task.decision = "notify-owner";
      claim.task.decisionLabel = "Notify the owner";
      claim.task.status = outcome === "failed" ? "callback_failed" : "callback_unknown";
      claim.task.reason = "An existing dispatch needs an explicit retry.";
      f.store.update(claim.task, claim.lease, true);
      const before = f.store.task(f.owner, task.id);
      expect((await f.call(task.id, "retry", { confirm: true }, { "x-test-owner": "bob" })).status).toBe(404);
      expect(
        (await f.call(task.id, "retry", { confirm: true }, { origin: "https://untrusted.example.test" })).status,
      ).toBe(403);
      expect((await f.call(task.id, "retry", {})).status).toBe(400);
      expect((await f.call(task.id, "retry", { confirm: false })).status).toBe(400);
      expect(f.store.task(f.owner, task.id)).toEqual(before);
      const retry = await f.call(task.id, "retry", { confirm: true });
      expect(retry.status).toBe(200);
      expect(retry.value.task).toMatchObject({
        status: "queued",
        decision: "notify-owner",
        decisionLabel: "Notify the owner",
        callbackStatus: "pending",
      });
      expect(
        retry.value.task.input.actions.find((action: { id: string }) => action.id === retry.value.task.decision)
          .callback.url,
      ).toBe("https://review-hooks.example.test/notify");
      expect((await f.call(task.id, "retry", { confirm: true })).status).toBe(409);
      expect(f.engineRequests).toBe(0);
    } finally {
      await f.close();
    }
  });
