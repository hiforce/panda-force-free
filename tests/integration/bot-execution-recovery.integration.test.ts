import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "../../src/server/bots/store.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";

test("bulk retry API protects ownership and origin and replays its durable acknowledgment", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-recovery-api-")),
    store = new BotStore(":memory:");
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
    owner: (context) => String(context.req.headers["x-test-owner"] ?? "alice"),
  });
  const dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://localhost") });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const bot = store.createBot("alice", { code: "retry-api", name: "Retry" });
  const task = store.submit(
    bot,
    { externalTaskId: "retry", instructions: "Inspect", input: { text: "Evidence", images: [] } },
    "retry",
  ).task;
  Object.assign(task, { status: "review", failure: "execution" });
  store.db.query("UPDATE bot_tasks SET status='review',data=? WHERE id=?").run(JSON.stringify(task), task.id);
  const request = { id: randomUUID(), taskIds: [task.id] };
  const call = (headers = {}, body: unknown = request) =>
    fetch(base + "/api/bots/tasks/retry-failed", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    expect((await call({ origin: "https://untrusted.example" })).status).toBe(403);
    expect(await (await call({ "x-test-owner": "bob" })).json()).toMatchObject({ queued: 0, skipped: 1 });
    expect(store.task("alice", task.id).status).toBe("review");
    const first = await call();
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(receipt).toMatchObject({ queued: 1, skipped: 0 });
    expect(await (await call()).json()).toEqual(receipt);
    expect((await call({}, { ...request, taskIds: [randomUUID()] })).status).toBe(409);
    expect(store.events("alice", task.id).filter((event) => event.kind === "resume")).toHaveLength(1);
  } finally {
    await feature.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

const configFile = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!configFile)(
  "MySQL durable recovery receipts and provider backoff protect original tasks across peers",
  async () => {
    const config = await Bun.file(configFile!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Use an isolated MySQL fixture");
    const sql = new SQL({ ...config, adapter: "mysql", max: 4 }),
      owner = "recovery-" + randomUUID();
    let store: MySQLBotStore | undefined;
    try {
      const registry = new DatabaseRegistry().register(mysqlBotModule),
        connection = new MySQLSchemaConnection(sql);
      await registry.upgrade(connection);
      expect((await mysqlBotModule.inspect!(connection)).length).toBe(0);
      store = await MySQLBotStore.open(sql);
      const peer = await MySQLBotStore.open(sql);
      const bot = await store.createBot(owner, { code: "recovery", name: "Recovery" });
      const submitted = await store.submit(
        bot,
        { externalTaskId: "fixture", instructions: "Inspect", input: { text: "Evidence", images: [] } },
        "original",
      );
      const claim = (await store.claim())!;
      expect(claim.task.id).toBe(submitted.task.id);
      await store.deferExecution(claim.task, claim.lease);
      expect((await store.task(owner, submitted.task.id)).status).toBe("queued");
      expect(await peer.claim()).toBeNull();
      await expect(store.deferExecution(claim.task, claim.lease)).rejects.toMatchObject({ code: "leaseLost" });
      await store.updateBot(owner, bot.id, { model: "healthy-fixture" });
      const resumed = (await peer.claim())!;
      expect(resumed.task.id).toBe(submitted.task.id);
      Object.assign(resumed.task, { status: "review", failure: "execution", decision: null });
      await peer.update(resumed.task, resumed.lease, true);
      const request = { id: randomUUID(), taskIds: [submitted.task.id] };
      const receipts = await Promise.all([store.retryFailed(owner, request), peer.retryFailed(owner, request)]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0]).toMatchObject({ queued: 1, skipped: 0 });
      expect((await peer.events(owner, submitted.task.id)).filter((event) => event.kind === "resume")).toHaveLength(1);
      const queued = (await peer.claim())!;
      Object.assign(queued.task, { status: "review", failure: "execution", decision: null });
      await peer.update(queued.task, queued.lease, true);
      expect(await store.retryFailed(owner, request)).toEqual(receipts[0]);
      expect((await store.task(owner, submitted.task.id)).status).toBe("review");
      await expect(peer.retryFailed(owner, { ...request, taskIds: [randomUUID()] })).rejects.toMatchObject({
        code: "idempotencyConflict",
      });
    } finally {
      store?.close();
      await sql`DELETE FROM panda_force_bot_events WHERE taskId IN (SELECT id FROM panda_force_bot_tasks WHERE owner=${owner})`;
      await sql`DELETE FROM panda_force_bot_tasks WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bots WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_recoveries WHERE owner=${owner}`;
      await sql.close();
    }
  },
  60000,
);
