import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
import { botTaskInput } from "../../src/shared/bots/contracts.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "MySQL additive review upgrade preserves old tasks and serializes generic human approvals",
  async () => {
    const fixture = await isolatedMySQLDatabase("botreview"),
      { sql } = fixture;
    let store: MySQLBotStore | undefined, peer: MySQLBotStore | undefined;
    try {
      const connection = new MySQLSchemaConnection(sql),
        prior = {
          ...mysqlBotModule,
          migrations: { mysql: mysqlBotModule.migrations.mysql!.slice(0, 2) },
          inspect: async () => [],
        };
      await new DatabaseRegistry().register(prior).upgrade(connection);
      await sql`CREATE TABLE unrelated_business(value VARCHAR(20))`;
      await sql`INSERT INTO unrelated_business VALUES('preserved')`;
      store = await MySQLBotStore.open(sql);
      const owner = randomUUID(),
        bot = await store.configureBot(owner, {
          name: "Publication reviewer",
          code: "publication",
          callbackHosts: ["api.example.com"],
        });
      const key = await store.issue(owner, { name: "Existing key", botIds: [bot.id] });
      const oldInput = {
        externalTaskId: "legacy",
        instructions: "Check facts",
        input: { text: "Original", images: [] },
      };
      const old = (await store.submit(bot, oldInput, "old")).task;
      const registry = new DatabaseRegistry().register(mysqlBotModule);
      await registry.upgrade(connection);
      await registry.upgrade(connection);
      expect(await registry.inspect(connection)).toEqual([]);
      expect((await store.task(owner, old.id)).input).toEqual(oldInput);
      expect((await store.submit(bot, oldInput, "old")).duplicate).toBe(true);
      expect(await store.authenticate(key.secret)).toEqual({ owner, botIds: [bot.id] });
      expect((await sql`SELECT value FROM unrelated_business`)[0].value).toBe("preserved");
      // Remove the independent fixture task from the runnable queue before approving the next one.
      await store.lifecycle(owner, old.id, "suspend");
      const actionId = "publish_approved_article_to_knowledge_base";
      const input = botTaskInput({
        externalTaskId: "publication-1",
        instructions: "Ask before publication",
        input: { text: "Draft", images: [] },
        actions: [
          {
            id: actionId,
            label: "发布审核后的文章",
            when: "Only after human approval",
            callback: {
              url: "https://api.example.com/publish",
              method: "POST",
              body: { article: "one" },
            },
          },
        ],
      });
      const task = (await store.submit(bot, input, "publication")).task,
        claim = (await store.claim())!;
      claim.task.status = "review";
      claim.task.decision = "review";
      claim.task.review = {
        id: randomUUID(),
        question: "是否发布？",
        options: [
          { id: "publish", label: "发布", actionId },
          { id: "revise", label: "继续修改" },
        ],
      };
      await store.update(claim.task, claim.lease, true);
      await store.updateBot(owner, bot.id, { active: false });
      peer = await MySQLBotStore.open(sql);
      const answer = { reviewId: claim.task.review.id, optionId: "publish" };
      const results = await Promise.all([store.review(owner, task.id, answer), peer.review(owner, task.id, answer)]);
      expect(results.map((r) => r.status)).toEqual(["queued", "queued"]);
      expect((await store.events(owner, task.id)).filter((e) => e.kind === "manual")).toHaveLength(1);
      await expect(peer.review(owner, task.id, { ...answer, optionId: "revise" })).rejects.toMatchObject({
        code: "staleReview",
      });
      expect((await store.queue(owner)).tasks.find((r) => r.id === task.id)?.decision).toBe(actionId);
      const callback = (await peer.claim())!;
      expect(callback.task.id).toBe(task.id);
      expect(callback.task.decision).toBe(actionId);
      await expect(store.lifecycle(owner, task.id, "cancel")).rejects.toMatchObject({ code: "callbackInFlight" });
      await sql`UPDATE panda_force_bot_tasks SET leaseUntil=0 WHERE id=${task.id}`;
      expect(await store.claim()).toBeNull();
      expect((await store.task(owner, task.id)).status).toBe("callback_unknown");
      await store.review(owner, task.id, actionId);
      const retry = (await peer.claim())!;
      expect(retry.task.decision).toBe(actionId);
      retry.task.status = "completed";
      retry.task.callbackStatus = "succeeded";
      await peer.update(retry.task, retry.lease, true);
      const summary = (await store.queue(owner)).tasks.find((r) => r.id === task.id)!;
      expect(summary).toMatchObject({
        decision: actionId,
        decisionLabel: "发布审核后的文章",
        state: "finished",
        callbackStatus: "succeeded",
      });
      const oldTime = Date.now() - 6 * 86400000;
      await sql`UPDATE panda_force_bot_tasks SET updatedAt=${oldTime},data=JSON_SET(data,'$.updatedAt',${oldTime}) WHERE id=${task.id}`;
      expect(await store.cleanup()).toBe(1);
      await expect(store.task(owner, task.id)).rejects.toMatchObject({ code: "notFound" });
      expect((await store.task(owner, old.id)).status).toBe("suspended");
    } finally {
      await store?.close();
      await peer?.close();
      await fixture.close();
    }
  },
  60000,
);
