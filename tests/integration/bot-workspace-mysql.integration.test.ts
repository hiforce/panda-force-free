import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";
import { MySQLBotStore } from "../../src/server/bots/mysql-store.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { botWorkspaceOverview } from "../../src/server/bots/workspace/overview.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/server/bots/store.js";
import { BotConnections } from "../../src/server/bots/integrations/connections.js";
import { BotChatWorker } from "../../src/server/bots/workspace/chat-worker.js";
import { migrateBotSnapshot } from "../../src/server/bots/migrate.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "MySQL workspace upgrade preserves tasks and serializes single chat, clear and owner isolation across peers",
  async () => {
    const fixture = await isolatedMySQLDatabase("botspace"),
      connection = new MySQLSchemaConnection(fixture.sql);
    let store: MySQLBotStore | undefined, peer: MySQLBotStore | undefined;
    try {
      const prior = {
        ...mysqlBotModule,
        migrations: { mysql: mysqlBotModule.migrations.mysql!.slice(0, 4) },
        inspect: async () => [],
      };
      await new DatabaseRegistry().register(prior).upgrade(connection);
      store = await MySQLBotStore.open(fixture.sql);
      const owner = randomUUID(),
        bot = await store.configureBot(owner, { code: "workspace", name: "Workspace Panda" });
      const task = (
        await store.submit(
          bot,
          {
            externalTaskId: "preserved",
            instructions: "Independent work",
            input: { text: "Background facts", images: [] },
          },
          "preserved",
        )
      ).task;
      const registry = new DatabaseRegistry().register(mysqlBotModule);
      await registry.upgrade(connection);
      await registry.upgrade(connection);
      expect(await registry.inspect(connection)).toEqual([]);
      peer = await MySQLBotStore.open(fixture.sql);
      const a = new BotChatService(store),
        b = new BotChatService(peer),
        request = { requestId: randomUUID(), generation: 1, text: "Human-only facts" };
      const sent = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).send(owner, bot.id, request)));
      expect(sent.filter((r) => !r.duplicate)).toHaveLength(1);
      expect((await b.snapshot(owner, bot.id)).messages).toHaveLength(2);
      expect((await b.snapshot(owner, bot.id)).messages[0]!.requestId).toBe(request.requestId);
      await expect(b.snapshot("other-owner", bot.id)).rejects.toMatchObject({ code: "notFound" });
      const clear = { requestId: randomUUID(), generation: 1 },
        cleared = await Promise.all([a.clear(owner, bot.id, clear), b.clear(owner, bot.id, clear)]);
      expect(cleared.filter((r) => !r.duplicate)).toHaveLength(1);
      expect((await a.snapshot(owner, bot.id)).messages).toEqual([]);
      await expect(b.send(owner, bot.id, request)).rejects.toMatchObject({ code: "staleConversation" });
      expect((await peer.task(owner, task.id)).input.input.text).toBe("Background facts");
      expect((await botWorkspaceOverview(peer, owner)).counts.queued).toBe(1);
      const key = { kind: "channel" as const, id: randomUUID() },
        put = { ...key, botId: bot.id, state: "active", dueAt: null, expiresAt: null, data: { title: "Private" } };
      const claims = await Promise.all(
        [store, peer].map((s) => s!.workspace.batch(owner, { checks: [{ ...key, version: null }], puts: [put] })),
      );
      expect(claims.sort()).toEqual([false, true]);
      expect(await peer.workspace.get("other-owner", key)).toBeNull();
      expect(
        await peer.workspace.batch(owner, {
          checks: [
            { ...key, version: 1 },
            { kind: "channel", id: "missing", version: 1 },
          ],
          removes: [key],
        }),
      ).toBe(false);
      expect(await peer.workspace.get(owner, key)).not.toBeNull();
      expect(await peer.workspace.counts(owner, "channel")).toEqual({ [bot.id]: { active: 1 } });
      const taskClaim = await store.claim();
      expect(taskClaim!.task.id).toBe(task.id);
      await store.update(
        { ...taskClaim!.task, status: "completed", decision: "complete", reason: "Evidence" },
        taskClaim!.lease,
        true,
      );
      const finished = await store.task(owner, task.id);
      expect(
        await peer.workspace.batch(owner, {
          checks: [{ ...key, version: 1 }],
          activeBots: [bot.id],
          completedTasks: [{ id: task.id, botId: bot.id, updatedAt: finished.updatedAt }],
          puts: [{ ...put, state: "checked" }],
        }),
      ).toBe(true);
      await store.updateBot(owner, bot.id, { active: false });
      expect(
        await peer.workspace.batch(owner, {
          checks: [{ ...key, version: 2 }],
          activeBots: [bot.id],
          puts: [{ ...put, state: "should-not-write" }],
        }),
      ).toBe(false);
      expect(
        await peer.workspace.batch(owner, {
          checks: [{ ...key, version: 2 }],
          completedTasks: [{ id: task.id, botId: bot.id, updatedAt: finished.updatedAt - 1 }],
          puts: [{ ...put, state: "should-not-write" }],
        }),
      ).toBe(false);
      expect((await peer.workspace.get(owner, key))!.state).toBe("checked");
    } finally {
      await store?.close();
      await peer?.close();
      await fixture.close();
    }
  },
  60000,
);

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "workspace snapshot migration preserves generation fences, queued cleanup and encrypted connections without copying plaintext credentials",
  async () => {
    const fixture = await isolatedMySQLDatabase("botcopy"),
      root = await mkdtemp(join(tmpdir(), "bot-workspace-copy-")),
      source = new BotStore(":memory:"),
      chat = new BotChatService(source),
      connections = new BotConnections(source.workspace, root);
    let target: MySQLBotStore | undefined, worker: BotChatWorker | undefined;
    try {
      await new DatabaseRegistry()
        .register(mysqlDataMigrationModule)
        .register(mysqlBotModule)
        .upgrade(new MySQLSchemaConnection(fixture.sql));
      const bot = source.createBot("alice", { code: "copy-chat", name: "Panda" }),
        request = { requestId: randomUUID(), generation: 1, text: "Human history before clearing" };
      await chat.send("alice", bot.id, request);
      await chat.clear("alice", bot.id, { requestId: randomUUID(), generation: 1 });
      const connection = await connections.save("alice", {
          id: randomUUID(),
          revision: 0,
          name: "Owned Slack",
          kind: "slack",
          credential: { token: "fixture-encrypted-during-copy" },
        }),
        snapshotPath = join(root, "snapshot.sqlite"),
        migrationId = randomUUID();
      source.db.query("VACUUM INTO ?").run(snapshotPath);
      await chmod(snapshotPath, 0o400);
      expect((await migrateBotSnapshot({ sql: fixture.sql, snapshotPath, migrationId })).state).toBe("complete");
      expect((await migrateBotSnapshot({ sql: fixture.sql, snapshotPath, migrationId })).state).toBe("complete");
      target = await MySQLBotStore.open(fixture.sql);
      const copied = new BotChatService(target);
      expect((await copied.snapshot("alice", bot.id)).generation).toBe(2);
      expect((await copied.snapshot("alice", bot.id)).cleanup).toBe("pending");
      await expect(copied.send("alice", bot.id, request)).rejects.toMatchObject({ code: "staleConversation" });
      const targetConnections = new BotConnections(target.workspace, root),
        encrypted = await targetConnections.row("alice", connection.id);
      expect(JSON.stringify(encrypted)).not.toContain("fixture-encrypted-during-copy");
      expect((await targetConnections.open("alice", encrypted)).token).toBe("fixture-encrypted-during-copy");
      expect(await target.workspace.counts("alice", "connection")).toEqual({ connections: { unverified: 1 } });
      worker = new BotChatWorker(
        target,
        () => {
          throw new Error("No model is needed to clean copied records");
        },
        (id) => join(root, "human", id),
      );
      const cleanupDeadline = Date.now() + 15000;
      while (Date.now() < cleanupDeadline && (await copied.snapshot("alice", bot.id)).cleanup !== "ready") {
        await worker.tick();
        await Bun.sleep(50);
      }
      expect((await copied.snapshot("alice", bot.id)).cleanup).toBe("ready");
      expect(await target.workspace.list("alice", "chat-message", { botId: bot.id })).toEqual([]);
      expect(await source.workspace.list("alice", "chat-message", { botId: bot.id })).toHaveLength(2);
    } finally {
      await worker?.close();
      await target?.close();
      source.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
