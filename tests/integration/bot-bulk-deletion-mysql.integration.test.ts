import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
const file = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!file)(
  "MySQL deletion arbitrates concurrent submission and preserves new-instance admission",
  async () => {
    const config = await Bun.file(file!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Use isolated local MySQL");
    const sql = new SQL({ ...config, adapter: "mysql", max: 8 }),
      owner = "bulk-delete-" + randomUUID();
    let store: MySQLBotStore | undefined;
    try {
      await new DatabaseRegistry().register(mysqlBotModule).upgrade(new MySQLSchemaConnection(sql));
      store = await MySQLBotStore.open(sql);
      const bot = await store.createBot(owner, { code: "generic", name: "Worker" });
      const input = {
        externalTaskId: "same-business-scope",
        instructions: "Review",
        input: { text: "Evidence", images: [] },
      };
      for (let index = 0; index < 8; index++) {
        const key = "old-instance-" + index;
        const result = await Promise.allSettled([
          store.submit(bot, input, key),
          store.bulkDelete(owner, { idempotencyKeys: [key] }, bot.id),
        ]);
        expect(result[1].status).toBe("fulfilled");
        await expect(store.submit(bot, input, key)).rejects.toThrow("taskDeleted");
      }
      expect((await store.tasks(owner)).length).toBe(0);
      const fresh = (await store.submit(bot, input, "regenerated-instance")).task;
      expect((await store.submit(bot, input, "regenerated-instance")).task.id).toBe(fresh.id);
      expect((await store.bulkDelete("another-owner", { taskIds: [fresh.id] })).blocked[0]?.code).toBe("notFound");
      const claim = (await store.claim())!;
      expect(claim.task.id).toBe(fresh.id);
      const result = await store.bulkDelete(owner, { taskIds: [fresh.id] });
      expect(result.deleted).toBe(1);
      expect(result.interrupted).toEqual([fresh.id]);
      await expect(store.update(claim.task, claim.lease)).rejects.toThrow();
      expect((await store.bulkDelete(owner, { taskIds: [fresh.id] })).alreadyDeleted).toBe(1);
      expect((await store.submit(bot, input, "next-generation")).duplicate).toBe(false);
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
