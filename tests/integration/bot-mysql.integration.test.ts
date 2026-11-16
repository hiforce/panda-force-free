import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { botQueueQuery } from "../../src/server/bots/queue-query.js";

const configFile = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!configFile)(
  "MySQL Bot storage preserves task identity, scoped keys, leases, sessions and retained history",
  async () => {
    const config = await Bun.file(configFile!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Use an isolated local MySQL fixture");
    const sql = new SQL({ ...config, adapter: "mysql", max: 8, connectionTimeout: 5, idleTimeout: 2 });
    const owner = "mysql-" + randomUUID(),
      scratch = await mkdtemp(join(tmpdir(), "bot-mysql-"));
    let first: MySQLBotStore | undefined, second: MySQLBotStore | undefined, worker: BotWorker | undefined;
    try {
      await new DatabaseRegistry().register(mysqlBotModule).upgrade(new MySQLSchemaConnection(sql));
      first = await MySQLBotStore.open(sql);
      second = await MySQLBotStore.open(sql);
      const store = first,
        peer = second;
      const bot = await store.createBot(owner, {
        code: "product-audit",
        name: "Product reviewer",
        callbackHosts: ["api.example.com"],
        persona: { role: "Fact checker" },
      });
      await expect(store.createBot(owner, { code: bot.code, name: "Must not replace" })).rejects.toMatchObject({
        code: "duplicateCode",
      });
      expect((await store.bot(owner, bot.id)).name).toBe("Product reviewer");
      await expect(store.bot("other-owner", bot.id)).rejects.toMatchObject({ code: "notFound" });
      const key = await store.issue(owner, { name: "PIM", botIds: [bot.id] });
      expect(await peer.authenticate(key.secret)).toEqual({ owner, botIds: [bot.id] });
      expect((await sql`SELECT data FROM panda_force_bot_keys WHERE id=${key.key.id}`)[0].data).not.toContain(
        key.secret,
      );
      await store.revoke(owner, key.key.id);
      await expect(peer.authenticate(key.secret)).rejects.toMatchObject({ code: "unauthorized" });
      const input = {
        externalTaskId: "product-a",
        title: "【预处理】品牌: VANS 货号: VN00H4XBA5 批次: batch",
        instructions: "Classify product facts",
        input: { text: "Product facts", images: [] },
      };
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) => (index % 2 ? store : peer).submit(bot, input, "same-request")),
      );
      expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      await expect(store.submit(bot, { ...input, instructions: "different" }, "same-request")).rejects.toMatchObject({
        code: "idempotencyConflict",
      });
      const claim = await store.claim();
      expect(claim?.task.id).toBe(results[0]!.task.id);
      expect(await peer.claim()).toBeNull();
      const paused = await peer.lifecycle(owner, claim!.task.id, "suspend");
      expect(paused.status).toBe("suspended");
      await expect(store.update(claim!.task, claim!.lease, true)).rejects.toMatchObject({ code: "leaseLost" });
      await peer.lifecycle(owner, claim!.task.id, "resume");
      const resumed = await store.claim();
      expect(resumed?.task.id).toBe(claim!.task.id);
      resumed!.task.status = "kept";
      resumed!.task.decision = "keep";
      await store.update(resumed!.task, resumed!.lease, true);
      const done = await store.task(owner, claim!.task.id);
      expect(done.state).toBe("finished");
      expect(done.title).toBe(input.title);
      await expect(peer.deleteTask("other-owner", done.id)).rejects.toMatchObject({ code: "notFound" });
      await store.setRetention(owner, 7);
      expect(await peer.retention(owner)).toEqual({ days: 7 });
      await store.setSession(owner, bot.id, "mysql-session-" + owner);
      const reopened = await MySQLBotStore.open(sql);
      expect(reopened.hasSession("mysql-session-" + owner)).toBe(true);
      reopened.close();
      await store.updateBot(owner, bot.id, { active: false });
      for (let index = 0; index < 27; index++)
        await store.submit(
          bot,
          { ...input, externalTaskId: "page-" + index, title: "Page task " + index },
          "page-" + index,
        );
      const page = await store.queue(owner, botQueueQuery(new URLSearchParams({ limit: "25" })));
      expect(page.total).toBe(28);
      expect(page.tasks).toHaveLength(25);
      expect(page.tasks[0]).not.toHaveProperty("input");
      const search = await store.queue(owner, botQueueQuery(new URLSearchParams({ q: "Page task 26" })));
      expect(search.total).toBe(1);
      expect((await store.queue("other-owner")).total).toBe(0);
      const id = page.tasks[0]!.id;
      await store.deleteTask(owner, id);
      await expect(store.task(owner, id)).rejects.toMatchObject({ code: "notFound" });
      await expect(
        store.submit(bot, { ...input, externalTaskId: "page-26", title: "Page task 26" }, "page-26"),
      ).rejects.toMatchObject({ code: "taskDeleted" });
      const avatar = "a".repeat(64),
        bytes = new Uint8Array([1, 2, 3]);
      await store.configureBot(owner, { avatar: { type: "image", id: avatar } }, bot.id, { id: avatar, bytes });
      expect([...(await peer.avatars.read(owner, avatar))]).toEqual([1, 2, 3]);
      await expect(peer.avatars.read("other-owner", avatar)).rejects.toMatchObject({ code: "notFound" });
      await store.configureBot(owner, { avatar: { type: "icon", icon: "panda", tone: "accent" } }, bot.id);
      await expect(peer.avatars.read(owner, avatar)).rejects.toMatchObject({ code: "notFound" });
      const apiFeature = createBotFeature({
        stateRoot: scratch,
        version: "fixture",
        connection: { mode: "isolated" },
        owner: (context) => String(context.req.headers["x-test-owner"] ?? owner),
        store: peer,
        engine: () => ({
          id: "fixture",
          async run() {
            throw Error("No inference expected");
          },
        }),
      });
      const route = createRouter(apiFeature.routes),
        server = createServer((req, res) => {
          const context = { req, res, url: new URL(req.url!, "http://localhost") };
          void (async () => {
            if (await apiFeature.handle(context)) return;
            if (!(await route(context))) res.writeHead(404).end();
          })();
        });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
      try {
        const response = await fetch(base + "/api/bots/queue?limit=25");
        expect(response.status).toBe(200);
        const queue = await response.json();
        expect(typeof queue.tasks[0].createdAt).toBe("number");
        expect(typeof queue.tasks[0].updatedAt).toBe("number");
        const eventResponse = await fetch(base + "/api/bots/tasks/" + done.id);
        expect(eventResponse.status).toBe(200);
        expect(typeof (await eventResponse.json()).events[0].createdAt).toBe("number");
        const isolated = await fetch(base + "/api/bots/queue", { headers: { "x-test-owner": "another-owner" } });
        expect((await isolated.json()).total).toBe(0);
      } finally {
        await apiFeature.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const workerBot = await store.createBot(owner, { code: "worker-audit", name: "Worker audit" });
      await store.submit(workerBot, { ...input, externalTaskId: "worker-task" }, "worker-task");
      worker = new BotWorker(
        store,
        () => ({
          id: "fixture",
          async run(request, callbacks) {
            const prompt = JSON.parse(request.prompt),
              sessionId = "worker-" + owner,
              runId = prompt.taskId;
            await callbacks.session?.(sessionId);
            await callbacks.started?.({ sessionId, runId });
            await callbacks.call({
              callId: "fixture-decision",
              sessionId,
              runId,
              name: "panda_bot_decide",
              arguments: { taskId: prompt.taskId, decision: "complete", reason: "Synthetic product facts verified" },
            });
            return { sessionId, runId, status: "completed" };
          },
        }),
        scratch,
      );
      await worker.tick();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await worker.tick();
        const queue = await store.queue(owner);
        if (queue.counts.finished === 2) break;
        await Bun.sleep(20);
      }
      expect((await store.queue(owner)).counts.finished).toBe(2);
      await worker.close();
      worker = undefined;
      expect(await store.cleanup(Date.now() + 8 * 86400000, 100)).toBe(2);
      expect((await store.queue(owner)).total).toBe(26);
    } catch (error) {
      if (error instanceof Error && error.cause) console.error("MySQL fixture failure", error.cause);
      throw error;
    } finally {
      await worker?.close();
      first?.close();
      second?.close();
      await sql`DELETE e FROM panda_force_bot_events e JOIN panda_force_bot_tasks t ON t.id=e.taskId WHERE t.owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_tasks WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_keys WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_avatars WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bots WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_settings WHERE owner=${owner}`;
      await sql.close();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  60000,
);
