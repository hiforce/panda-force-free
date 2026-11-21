import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
const file = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!file)(
  "MySQL assistant deletion fences stale writers, revokes only its grants and serializes submission",
  async () => {
    const config = await Bun.file(file!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Use isolated local MySQL");
    const sql = new SQL({ ...config, adapter: "mysql", max: 8 }),
      owner = "assistant-delete-" + randomUUID();
    let store: MySQLBotStore | undefined;
    try {
      await new DatabaseRegistry().register(mysqlBotModule).upgrade(new MySQLSchemaConnection(sql));
      store = await MySQLBotStore.open(sql);
      const bot = await store.createBot(owner, { code: "first", name: "First" }),
        other = await store.createBot(owner, { code: "other", name: "Other" }),
        key = await store.issue(owner, { name: "Shared", botIds: [bot.id, other.id], days: 1 });
      const item = {
        kind: "chat" as const,
        id: randomUUID(),
        botId: bot.id,
        state: "idle",
        dueAt: null,
        expiresAt: null,
        data: {},
      };
      expect(
        await store.workspace.batch(owner, { checks: [{ kind: item.kind, id: item.id, version: null }], puts: [item] }),
      ).toBe(true);
      await expect(store.deleteBot("foreign-owner", bot.id)).rejects.toThrow("notFound");
      await store.deleteBot(owner, bot.id);
      expect((await store.bots(owner)).map((b) => b.id)).toEqual([other.id]);
      expect((await store.authenticate(key.secret)).botIds).toEqual([other.id]);
      expect(await store.workspace.get(owner, { kind: item.kind, id: item.id })).toBeNull();
      expect(
        await store.workspace.batch(owner, { checks: [{ kind: item.kind, id: item.id, version: null }], puts: [item] }),
      ).toBe(false);
      const input = { externalTaskId: "same-product", instructions: "Review", input: { text: "Evidence", images: [] } };
      for (let i = 0; i < 6; i++) {
        const b = await store.createBot(owner, { code: "race-" + i, name: "Race" });
        const results = await Promise.allSettled([store.submit(b, input, "instance"), store.deleteBot(owner, b.id)]);
        if (results[1].status === "fulfilled") {
          expect(results[0].status).toBe("rejected");
          await expect(store.bot(owner, b.id)).rejects.toThrow("notFound");
        } else {
          expect(results[0].status).toBe("fulfilled");
          expect((results[1] as PromiseRejectedResult).reason.message).toBe("botBusy");
          await store.bulkDelete(owner, { taskIds: [(results[0] as PromiseFulfilledResult<any>).value.task.id] });
          await store.deleteBot(owner, b.id);
        }
      }
    } finally {
      store?.close();
      await sql`DELETE FROM panda_force_bot_events WHERE taskId IN (SELECT id FROM panda_force_bot_tasks WHERE owner=${owner})`;
      await sql`DELETE FROM panda_force_bot_tasks WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_workspace_records WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bot_keys WHERE owner=${owner}`;
      await sql`DELETE FROM panda_force_bots WHERE owner=${owner}`;
      await sql.close();
    }
  },
);
