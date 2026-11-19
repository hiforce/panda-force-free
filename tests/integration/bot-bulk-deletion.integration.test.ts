import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { BotStore } from "../../src/server/bots/store.js";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("API-key deletion is bot-scoped, fences out-of-order submissions, and UI bulk deletion is owner-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-delete-api-")),
    store = new BotStore(":memory:");
  const bot = store.createBot("alice", { code: "generic", name: "Generic" }),
    other = store.createBot("alice", { code: "other-bot", name: "Other" });
  const key = store.issue("alice", { name: "Backend", botIds: [bot.id], days: 1 });
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
    store: parked,
    owner: (c) => String(c.req.headers["x-test-owner"] ?? "alice"),
  });
  const dispatch = createRouter(feature.routes);
  const server = createServer((req, res) => {
    const context = { req, res, url: new URL(req.url!, "http://localhost") };
    void (async () => {
      if (await dispatch(context)) return;
      if (await feature.handle(context)) return;
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  try {
    const route = "/api/v1/bots/generic/tasks",
      auth = { authorization: "Bearer " + key.secret };
    expect((await call(route + "/delete", { idempotencyKeys: ["old-instance"] })).status).toBe(401);
    expect(
      (await call("/api/v1/bots/other-bot/tasks/delete", { idempotencyKeys: ["old-instance"] }, auth)).status,
    ).toBe(403);
    expect((await call(route + "/delete", { idempotencyKeys: ["old-instance"] }, auth)).value.alreadyDeleted).toBe(1);
    const input = {
      externalTaskId: "business-scope",
      instructions: "Review evidence",
      input: { text: "Evidence", images: [] },
    };
    expect((await call(route, input, { ...auth, "idempotency-key": "old-instance" })).status).toBe(409);
    const fresh = await call(route, input, { ...auth, "idempotency-key": "new-instance" });
    expect(fresh.status).toBe(202);
    const unrelated = store.submit(other, input, "new-instance").task;
    expect(
      (await call("/api/bots/tasks/delete", { taskIds: [fresh.value.task.id] }, { "x-test-owner": "bob" })).value
        .blocked[0].code,
    ).toBe("notFound");
    expect(
      (await call("/api/bots/tasks/delete", { taskIds: [fresh.value.task.id] }, { origin: "https://attacker.invalid" }))
        .status,
    ).toBe(403);
    expect((await call("/api/bots/tasks/delete", { taskIds: [fresh.value.task.id] })).value.deleted).toBe(1);
    expect((await call("/api/bots/tasks/delete", { taskIds: [fresh.value.task.id] })).value.alreadyDeleted).toBe(1);
    expect(store.task("alice", unrelated.id).status).toBe("queued");
    expect((await call(route, input, { ...auth, "idempotency-key": "third-instance" })).status).toBe(202);
  } finally {
    await feature.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
