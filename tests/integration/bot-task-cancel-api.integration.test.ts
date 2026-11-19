import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { BotStore } from "../../src/server/bots/store.js";
import { botTaskData } from "../../src/server/bots/task-record.js";
import { createRouter } from "../../src/server/http/router.js";

async function fixture(engine?: ApplicationToolEngine) {
  const root = await mkdtemp(join(tmpdir(), "bot-cancel-api-")),
    store = new BotStore(":memory:"),
    feature = createBotFeature({
      stateRoot: root,
      version: "test",
      connection: { mode: "isolated" },
      store,
      owner: (context) => String(context.req.headers["x-test-owner"] ?? "alice"),
      engine: () =>
        engine ?? {
          id: "unused",
          async run() {
            throw new Error("Paused fixture bots must not execute");
          },
        },
    }),
    dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      const context = { req, res, url: new URL(req.url!, "http://localhost") };
      void (async () => {
        if (await feature.handle(context)) return;
        if (await dispatch(context)) return;
        res.writeHead(404).end();
      })();
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", origin: base, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    store,
    call,
    async bot(code: string, owner = "alice", paused = true) {
      const headers = { "x-test-owner": owner },
        created = await call("/api/bots", "POST", { code, name: code }, headers);
      expect(created.status).toBe(201);
      const bot = created.value.bot;
      if (paused) expect((await call("/api/bots/" + bot.id, "PATCH", { active: false }, headers)).status).toBe(200);
      return bot;
    },
    async key(botIds: string[], owner = "alice") {
      const issued = await call(
        "/api/bots/keys",
        "POST",
        { name: "Test integration", botIds, days: 1 },
        { "x-test-owner": owner },
      );
      expect(issued.status).toBe(201);
      return issued.value;
    },
    async close() {
      await feature.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const input = {
  title: "Review a draft",
  externalTaskId: "draft-001",
  instructions: "Review the supplied facts without external actions",
  input: { text: "A fictional draft for testing", images: [] },
};

test("Bot keys cancel only owned and scoped tasks, preserve idempotency and enforce lifecycle guards", async () => {
  const app = await fixture();
  try {
    const bot = await app.bot("draft-review"),
      other = await app.bot("another-review"),
      foreign = await app.bot("foreign-review", "bob"),
      key = await app.key([bot.id]),
      multi = await app.key([bot.id, other.id]),
      foreignKey = await app.key([foreign.id], "bob"),
      path = `/api/v1/bots/${bot.code}/tasks`,
      headers = { authorization: "Bearer " + key.secret, "idempotency-key": input.externalTaskId },
      created = await app.call(path, "POST", input, headers),
      id = created.value.task.id,
      cancel = path + "/" + id + "/cancel";
    expect(created.status).toBe(202);
    expect((await app.call(cancel, "POST", {})).status).toBe(401);
    expect((await app.call(cancel, "POST", {}, { authorization: "Bearer invalid" })).status).toBe(401);
    expect((await app.call(cancel, "POST", {}, { authorization: "Bearer " + foreignKey.secret })).status).toBe(404);
    expect((await app.call(`/api/v1/bots/${other.code}/tasks/${id}/cancel`, "POST", {}, headers)).status).toBe(403);
    expect(
      (
        await app.call(
          `/api/v1/bots/${other.code}/tasks/${id}/cancel`,
          "POST",
          {},
          { authorization: "Bearer " + multi.secret },
        )
      ).status,
    ).toBe(404);
    expect((await app.call(cancel, "GET", undefined, headers)).status).toBe(405);
    expect((await app.call(cancel, "POST", { confirm: true }, headers)).status).toBe(400);
    expect((await app.call(cancel, "POST", [], headers)).status).toBe(400);
    expect(app.store.task("alice", id).status).toBe("queued");
    const canceled = await app.call(cancel, "POST", {}, headers);
    expect(canceled.status).toBe(200);
    expect(canceled.value.task.state).toBe("canceled");
    expect((await app.call(cancel, "POST", {}, headers)).value.task).toEqual(canceled.value.task);
    expect((await app.call(path + "/" + id, "GET", undefined, headers)).value.task.state).toBe("canceled");
    const replay = await app.call(path, "POST", input, headers);
    expect(replay.status).toBe(200);
    expect(replay.value.duplicate).toBe(true);
    expect(replay.value.task.id).toBe(id);
    expect(replay.value.task.state).toBe("canceled");
    expect((await app.call(path, "POST", { ...input, instructions: "Changed" }, headers)).status).toBe(409);

    for (const [status, code] of [
      ["completed", "invalidState"],
      ["callback_unknown", "callbackInFlight"],
    ] as const) {
      const task = app.store.submit(app.store.bot("alice", bot.id), input, status).task;
      task.status = status;
      task.decision = "complete";
      app.store.db.query("UPDATE bot_tasks SET status=?,data=? WHERE id=?").run(status, botTaskData(task), task.id);
      const result = await app.call(path + "/" + task.id + "/cancel", "POST", {}, headers);
      expect(result.status).toBe(409);
      expect(result.value.error.code).toBe(code);
      expect(app.store.task("alice", task.id).status).toBe(status);
    }
    expect((await app.call("/api/bots/keys/" + key.key.id, "DELETE")).status).toBe(200);
    expect((await app.call(cancel, "POST", {}, headers)).status).toBe(401);
  } finally {
    await app.close();
  }
});

test("HTTP cancellation fences a running lease before interrupting and rejects late engine output", async () => {
  let release!: () => void,
    started!: () => void,
    finished!: () => void,
    signal: AbortSignal | undefined,
    lateRejected = false;
  const startedPromise = new Promise<void>((resolve) => (started = resolve)),
    releasePromise = new Promise<void>((resolve) => (release = resolve)),
    finishedPromise = new Promise<void>((resolve) => (finished = resolve)),
    app = await fixture({
      id: "controlled",
      async run(request, callbacks) {
        const taskId = (JSON.parse(request.prompt) as { taskId: string }).taskId,
          scope = { sessionId: "isolated-cancel-session", runId: "isolated-cancel-run" };
        signal = callbacks.signal;
        await callbacks.session?.(scope.sessionId);
        await callbacks.started(scope);
        started();
        await releasePromise;
        try {
          await callbacks.call({
            ...scope,
            callId: "late-decision",
            name: "panda_bot_decide",
            arguments: { taskId, decision: "complete", reason: "A late result must not revive a canceled task" },
          });
        } catch {
          lateRejected = true;
        } finally {
          finished();
        }
        return { ...scope, status: "completed" };
      },
    });
  try {
    const bot = await app.bot("running-review", "alice", false),
      key = await app.key([bot.id]),
      headers = { authorization: "Bearer " + key.secret, "idempotency-key": "running" },
      path = `/api/v1/bots/${bot.code}/tasks`,
      created = await app.call(path, "POST", input, headers),
      id = created.value.task.id;
    await Promise.race([
      startedPromise,
      Bun.sleep(5000).then(() => {
        throw new Error("Engine did not start");
      }),
    ]);
    expect(app.store.task("alice", id).status).toBe("running");
    expect((await app.call(path + "/" + id + "/cancel", "POST", {}, headers)).status).toBe(200);
    expect(signal?.aborted).toBe(true);
    const row = app.store.db
      .query<{ status: string; lease: string | null; leaseUntil: number | null }, [string]>(
        "SELECT status,lease,leaseUntil FROM bot_tasks WHERE id=?",
      )
      .get(id);
    expect(row).toEqual({ status: "canceled", lease: null, leaseUntil: null });
    release();
    await finishedPromise;
    expect(lateRejected).toBe(true);
    expect((await app.call(path + "/" + id, "GET", undefined, headers)).value.task.state).toBe("canceled");
  } finally {
    release();
    await app.close();
  }
});
