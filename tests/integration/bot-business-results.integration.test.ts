import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
const configFile = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!configFile)(
  "MySQL queue exposes bounded business evidence without rewriting historical complete decisions",
  async () => {
    const config = await Bun.file(configFile!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Use an isolated local MySQL fixture");
    const sql = new SQL({ ...config, adapter: "mysql", max: 4 }),
      owner = "business-result-" + randomUUID();
    let store: MySQLBotStore | undefined;
    try {
      await new DatabaseRegistry().register(mysqlBotModule).upgrade(new MySQLSchemaConnection(sql));
      store = await MySQLBotStore.open(sql);
      const bot = await store.createBot(owner, { code: "business-result", name: "Reviewer" });
      const { task } = await store.submit(
        bot,
        { externalTaskId: "jacket", instructions: "Audit", input: { text: "Jacket", images: [] } },
        "jacket",
      );
      const claim = (await store.claim())!;
      expect(claim.task.id).toBe(task.id);
      Object.assign(claim.task, {
        status: "completed",
        decision: "complete",
        reason: "保留｜女士夹克符合服装范围。" + "实际证据".repeat(200),
      });
      await store.update(claim.task, claim.lease, true);
      const queue = await store.queue(owner),
        row = queue.tasks[0]!;
      expect(row.reason).toStartWith("保留｜女士夹克符合服装范围。");
      expect(row.reason!.length).toBe(400);
      expect(row.decision).toBe("complete");
      expect((await store.task(owner, task.id)).reason!.length).toBeGreaterThan(400);
      expect((await store.queue("other-owner")).tasks).toEqual([]);
    } finally {
      store?.close();
      await sql`DELETE FROM panda_force_bot_events WHERE taskId IN (SELECT id FROM panda_force_bot_tasks WHERE owner=${owner})`;
      await sql`DELETE FROM panda_force_bot_tasks WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bots WHERE owner=${owner}`;
      await sql.close();
    }
  },
  30000,
);
