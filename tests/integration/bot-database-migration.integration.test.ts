import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
import { migrateBotSnapshot, botMigrationTables } from "../../src/server/bots/migrate.js";
import { migrateSQLiteModule } from "../../src/server/database/data-migration.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";

const path = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!path)(
  "SQLite to MySQL migration resumes atomic batches and verifies identities, keys, binary data and replay protection",
  async () => {
    const config = await Bun.file(path!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Dedicated local test server required");
    const schema = "panda_force_test_migration_" + randomUUID().replaceAll("-", "");
    if (!/^panda_force_test_migration_[a-f0-9]{32}$/.test(schema)) throw Error("Invalid fixture scope");
    const admin = new SQL({ ...config, adapter: "mysql", max: 2 });
    await admin.unsafe(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const sql = new SQL({ ...config, database: schema, adapter: "mysql", max: 4 });
    const directory = await mkdtemp(join(tmpdir(), "panda-db-copy-")),
      source = new BotStore(":memory:");
    let target: MySQLBotStore | undefined;
    try {
      await new DatabaseRegistry()
        .register(mysqlDataMigrationModule)
        .register(mysqlBotModule)
        .upgrade(new MySQLSchemaConnection(sql));
      await sql.unsafe("CREATE TABLE existing_business(id INT PRIMARY KEY,value VARCHAR(64))");
      await sql`INSERT INTO existing_business VALUES(42,'preserved')`;
      const owner = "migration-owner",
        bot = source.createBot(owner, { code: "products", name: "商品资料助理" });
      const key = source.issue(owner, { name: "PIM", botIds: [bot.id] });
      const input = {
        externalTaskId: "legacy-one",
        title: "【预处理】品牌: VANS 货号: VN00H4XBA5 批次: 20261113:vans.au.extra.cfs",
        instructions: "Inspect product evidence",
        input: { text: "原始商品内容\nPreserve author text exactly.", images: [] },
      };
      const done = source.submit(bot, input, "done").task;
      const claim = source.claim()!;
      claim.task.status = "kept";
      claim.task.decision = "keep";
      source.update(claim.task, claim.lease, true);
      source.event(done.id, "verified", "原始事实与理由");
      const running = source.submit(bot, { ...input, externalTaskId: "interrupted" }, "running").task;
      source.claim();
      const pending = source.submit(bot, { ...input, externalTaskId: "pending" }, "pending").task;
      const deleted = source.submit(bot, { ...input, externalTaskId: "deleted" }, "deleted").task;
      source.deleteTask(owner, deleted.id);
      source.setRetention(owner, 7);
      source.setSession(owner, bot.id, "private-session-one");
      source.setSession(owner, bot.id, "private-session-two");
      const avatar = "b".repeat(64),
        bytes = new Uint8Array([0, 255, 128, 1, 2, 0]);
      source.configureBot(owner, { avatar: { type: "image", id: avatar } }, bot.id, { id: avatar, bytes });
      source.updateBot(owner, bot.id, { active: false });
      const actionId = "approve_verified_product_for_publication";
      const generic = source.submit(
        bot,
        { ...input, externalTaskId: "generic-action", actions: [{ id: actionId, label: "通过商品资料复核" }] },
        "generic-action",
      ).task;
      generic.status = "completed";
      generic.decision = actionId;
      generic.decisionLabel = "通过商品资料复核";
      source.db
        .query("UPDATE bot_tasks SET status=?,data=? WHERE id=?")
        .run(generic.status, JSON.stringify(generic), generic.id);
      const snapshotPath = join(directory, "snapshot.sqlite");
      const recoveryRequest = { id: randomUUID(), taskIds: [done.id] };
      const recoveryReceipt = source.retryFailed(owner, recoveryRequest);
      source.db.query("VACUUM INTO ?").run(snapshotPath);
      await chmod(snapshotPath, 0o400);
      const migrationId = randomUUID();
      let interrupted = false;
      await expect(
        migrateBotSnapshot({
          sql,
          snapshotPath,
          migrationId,
          progress: (progress) => {
            if (!interrupted && progress.stage === "copy") {
              interrupted = true;
              throw Error("Simulated interruption after commit");
            }
          },
        }),
      ).rejects.toThrow("Simulated interruption after commit");
      expect((await sql`SELECT state FROM panda_force_data_migration_runs WHERE id=${migrationId}`)[0].state).toBe(
        "failed",
      );
      const result = await migrateBotSnapshot({ sql, snapshotPath, migrationId });
      expect(result.state).toBe("complete");
      await migrateBotSnapshot({ sql, snapshotPath, migrationId });
      await expect(
        migrateSQLiteModule({
          sql,
          snapshotPath,
          migrationId,
          module: "bots",
          tables: botMigrationTables,
          converterVersion: 5,
        }),
      ).rejects.toThrow("migrationMappingChanged");
      expect((await sql`SELECT state FROM panda_force_data_migration_runs WHERE id=${migrationId}`)[0].state).toBe(
        "complete",
      );
      expect((await sql`SELECT COUNT(*) n FROM panda_force_bot_tasks`)[0].n).toBe(5);
      expect((await sql`SELECT value FROM existing_business WHERE id=42`)[0].value).toBe("preserved");
      target = await MySQLBotStore.open(sql);
      expect(await target.retryFailed(owner, recoveryRequest)).toEqual(recoveryReceipt);
      expect((await sql`SELECT COUNT(*) n FROM panda_force_bot_recoveries WHERE owner=${owner}`)[0].n).toBe(1);
      expect((await target.authenticate(key.secret)).botIds).toEqual([bot.id]);
      expect((await target.task(owner, done.id)).input).toEqual(source.task(owner, done.id).input);
      expect((await target.task(owner, pending.id)).title).toBe(input.title);
      expect((await target.task(owner, generic.id)).decision).toBe(actionId);
      expect((await sql`SELECT decision,actionId FROM panda_force_bot_tasks WHERE id=${generic.id}`)[0]).toMatchObject({
        decision: null,
        actionId,
      });
      expect((await target.queue(owner)).tasks.find((t) => t.id === generic.id)).toMatchObject({
        decision: actionId,
        decisionLabel: "通过商品资料复核",
        state: "finished",
      });
      expect(await target.events(owner, done.id)).toEqual(source.events(owner, done.id));
      expect([...(await target.avatars.read(owner, avatar))]).toEqual([...bytes]);
      expect(await target.retention(owner)).toEqual({ days: 7 });
      expect(target.hasSession("private-session-one")).toBe(true);
      expect(target.hasSession("private-session-two")).toBe(true);
      await expect(target.submit(bot, { ...input, externalTaskId: "deleted" }, "deleted")).rejects.toMatchObject({
        code: "taskDeleted",
      });
      await sql`UPDATE panda_force_bot_tasks SET leaseUntil=0 WHERE id=${running.id}`;
      expect(await target.claim()).toBeNull();
      expect((await target.task(owner, running.id)).state).toBe("error");
      await expect(migrateBotSnapshot({ sql, snapshotPath, migrationId })).rejects.toThrow(
        "migrationVerificationFailed",
      );
      expect((await target.task(owner, running.id)).state).toBe("error");
    } finally {
      target?.close();
      source.close();
      await sql.close();
      // This schema was generated by this test on the guarded loopback-only fixture.
      await admin.unsafe(`DROP DATABASE ${schema}`);
      await admin.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
