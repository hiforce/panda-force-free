import { test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { openBotDatabase, readBotDatabaseConfig } from "../../src/server/bots/database.js";

test("Bot database selection remains independent and rejects an explicitly missing selector", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-selector-"));
  try {
    expect(await readBotDatabaseConfig(root, {})).toEqual({ schema: 1, driver: "sqlite" });
    expect(await readBotDatabaseConfig(root, { PANDA_FORCE_DATABASE_CONFIG_FILE: "/absent/global.json" })).toEqual({
      schema: 1,
      driver: "sqlite",
    });
    await expect(
      readBotDatabaseConfig(root, { PANDA_FORCE_BOT_DATABASE_CONFIG_FILE: join(root, "absent.json") }),
    ).rejects.toThrow("invalidBotDatabaseConfiguration");
    const file = join(root, "ports.json"),
      env = { PANDA_FORCE_BOT_DATABASE_CONFIG_FILE: file };
    const mysql = {
      hostname: "127.0.0.1",
      database: "fixture",
      username: "fixture",
      password: "fixture",
      tls: { mode: "disabled" },
      port: "3306",
    };
    await writeFile(file, JSON.stringify({ schema: 1, driver: "mysql", mysql }), { mode: 0o600 });
    const parsed = await readBotDatabaseConfig(root, env);
    expect(parsed.driver === "mysql" && parsed.mysql.port).toBe(3306);
    for (const port of ["0", "65536", "3306x", "3.3", " 3306"]) {
      await writeFile(file, JSON.stringify({ schema: 1, driver: "mysql", mysql: { ...mysql, port } }));
      await expect(readBotDatabaseConfig(root, env)).rejects.toThrow("invalidBotDatabaseConfiguration");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const path = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!path)(
  "Bot-only startup verifies a frozen migration, survives restart and refuses stale SQLite rollback",
  async () => {
    const config = await Bun.file(path!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw new Error("Dedicated loopback fixture required");
    const schema = "panda_force_test_bootstrap_" + randomUUID().replaceAll("-", ""),
      admin = new SQL({ ...config, adapter: "mysql", max: 2 }),
      root = await mkdtemp(join(tmpdir(), "bot-startup-"));
    await admin.unsafe(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const sql = new SQL({ ...config, database: schema, adapter: "mysql", max: 4 });
    let runtime: Awaited<ReturnType<typeof openBotDatabase>> | undefined;
    try {
      const source = new BotStore(join(root, "data", "bot-tasks.sqlite")),
        bot = source.createBot("owner", { code: "audit", name: "Audit" }),
        key = source.issue("owner", { name: "PIM", botIds: [bot.id] }),
        input = {
          externalTaskId: "legacy",
          title: "Preserved title",
          instructions: "Fixture",
          input: { text: "Facts", images: [] },
        },
        legacy = source.submit(bot, input, "legacy").task;
      source.setSession("owner", bot.id, "private-session");
      source.setRetention("owner", 5);
      source.close();
      await mkdir(join(root, "config"));
      const caFile = join(root, "fixture-ca.pem");
      await writeFile(caFile, config.tls.ca, { mode: 0o600 });
      const selector = join(root, "config", "bot-database.json"),
        env = { PANDA_FORCE_BOT_DATABASE_CONFIG_FILE: selector };
      await writeFile(
        selector,
        JSON.stringify({
          schema: 1,
          driver: "mysql",
          mysql: {
            hostname: config.hostname,
            port: config.port,
            username: config.username,
            password: config.password,
            database: schema,
            tls: { mode: "verify", caFile },
            max: 8,
          },
        }),
        { mode: 0o600 },
      );
      await expect(openBotDatabase(root, env)).rejects.toThrow("botDatabaseMigrationRequired");
      runtime = await openBotDatabase(root, { ...env, PANDA_FORCE_BOT_DATABASE_MIGRATE: "sqlite" });
      expect(runtime.driver).toBe("mysql");
      const store = runtime.store!;
      expect((await store.authenticate(key.secret)).owner).toBe("owner");
      expect((await store.task("owner", legacy.id)).title).toBe(input.title);
      expect(store.hasSession("private-session")).toBe(true);
      expect(await store.retention("owner")).toEqual({ days: 5 });
      const start = performance.now();
      // Admission is measured independently from model execution. No engine or business callbacks run.
      for (let offset = 0; offset < 1500; offset += 16)
        await Promise.all(
          Array.from({ length: Math.min(16, 1500 - offset) }, (_, index) => {
            const id = "burst-" + (offset + index);
            return store.submit(bot, { ...input, externalTaskId: id }, id);
          }),
        );
      const page = await store.queue("owner");
      expect(page.total).toBe(1501);
      expect(page.tasks).toHaveLength(50);
      console.info(
        JSON.stringify({
          fixture: "loopback-mysql-admission",
          tasks: 1500,
          milliseconds: Math.round(performance.now() - start),
          modelRuns: 0,
        }),
      );
      await store.close();
      await runtime.close();
      runtime = undefined;
      // A stale local ledger must neither overwrite MySQL history nor be selected by removing its config.
      const stale = new BotStore(join(root, "data", "bot-tasks.sqlite"));
      stale.submit(bot, { ...input, externalTaskId: "stale-only" }, "stale-only");
      stale.close();
      await rename(selector, selector + ".saved");
      await expect(openBotDatabase(root, {})).rejects.toThrow("botDatabaseRollbackRequiresMigration");
      await rename(selector + ".saved", selector);
      // The default selector exists, so explicitly test a SQLite selector as well.
      const sqlite = join(root, "sqlite.json");
      await writeFile(sqlite, '{"schema":1,"driver":"sqlite"}', { mode: 0o600 });
      await expect(openBotDatabase(root, { PANDA_FORCE_BOT_DATABASE_CONFIG_FILE: sqlite })).rejects.toThrow(
        "botDatabaseRollbackRequiresMigration",
      );
      runtime = await openBotDatabase(root, env);
      expect((await runtime.store!.queue("owner")).total).toBe(1501);
      expect((await sql`SELECT COUNT(*) n FROM panda_force_data_migration_runs WHERE module='bots'`)[0].n).toBe(1);
      const stolen = await mkdtemp(join(tmpdir(), "bot-other-install-"));
      try {
        await expect(openBotDatabase(stolen, { ...env, PANDA_FORCE_BOT_DATABASE_MIGRATE: "sqlite" })).rejects.toThrow(
          "botDatabaseAlreadyOwned",
        );
      } finally {
        await rm(stolen, { recursive: true, force: true });
      }
    } finally {
      await runtime?.store?.close();
      await runtime?.close();
      await sql.close();
      await admin.unsafe(`DROP DATABASE ${schema}`);
      await admin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  300000,
);
