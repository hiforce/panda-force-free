import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { MySQLCreationLedger, personalCreationLedgerNamespace } from "../../src/server/creation/storage/mysql.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { CreationQuestionRepository } from "../../src/server/creation/storage/questions.js";
import { SQLiteCreationGoals } from "../../src/server/creation/storage/goals.js";
import { CreationQueue } from "../../src/server/creation/storage/queue.js";
import { consolidateCreationSnapshots, importCreationSQLite } from "../../src/server/creation/storage/mysql-import.js";
const enabled = !!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
const spec = (
  id = randomUUID(),
  operationId = randomUUID(),
): import("../../src/server/creation/contracts.js").CreationTaskSpec => ({
  schema: 1,
  id,
  operationId,
  owner: "owner",
  projectId: "project-1",
  kind: "document",
  target: { parentId: null, treeVersion: 0, locale: "en" },
  inputDigest: "a".repeat(64),
  skillCaptureId: randomUUID(),
});
test.skipIf(!enabled)(
  "creation MySQL preserves distinct application/personal identities, durable questions, cancellation and replay across frozen snapshot import",
  async () => {
    const f = await isolatedMySQLDatabase("creation"),
      root = await mkdtemp(join(tmpdir(), "creation-mysql-"));
    try {
      const paths = ["application", personalCreationLedgerNamespace("owner")].map((namespace, i) => ({
          namespace,
          snapshotPath: join(root, `ledger-${i}.sqlite`),
        })),
        s = spec(),
        paused = spec();
      let questionId = "";
      for (const path of paths) {
        const db = openCreationDatabase(path.snapshotPath);
        try {
          const tasks = new CreationTaskRepository(db),
            questions = new CreationQuestionRepository(db, tasks),
            goals = new SQLiteCreationGoals(db, tasks, new CreationQueue(db, tasks));
          tasks.create(s, 10000);
          goals.command(
            "owner",
            s.id,
            { id: randomUUID(), action: "create", objective: "Retain the complete imported goal" },
            10000,
          );
          tasks.create(paused, 10000);
          goals.command(
            "owner",
            paused.id,
            { id: randomUUID(), action: "create", objective: "Keep the paused creation" },
            10000,
          );
          goals.command("owner", paused.id, { id: randomUUID(), action: "pause" }, 10001);
          const lease = tasks.claim("owner", s.id, 10000, 30000),
            scope = tasks.bind(lease, "session", "run", 10000);
          questionId = questions.register(scope, "b".repeat(64), 10001).id;
        } finally {
          db.close();
        }
      }
      const snapshotPath = join(root, "consolidated.sqlite");
      consolidateCreationSnapshots(snapshotPath, paths);
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlCreationModule),
        schema = new MySQLSchemaConnection(f.sql);
      await registry.upgrade(schema);
      await importCreationSQLite({ sql: f.sql, snapshotPath, migrationId: "creation-v1" });
      await importCreationSQLite({ sql: f.sql, snapshotPath, migrationId: "creation-v1" });
      expect(await mysqlCreationModule.inspect(schema)).toEqual([]);
      const app = new MySQLCreationLedger(f.sql, "application"),
        personal = new MySQLCreationLedger(f.sql, personalCreationLedgerNamespace("owner"));
      expect((await app.get("owner", s.id)).spec).toEqual(s);
      expect((await personal.get("owner", s.id)).spec).toEqual(s);
      for (const ledger of [app, personal]) {
        expect((await ledger.goals.read("owner", s.id))?.goal?.objective).toBe("Retain the complete imported goal");
        expect((await ledger.goals.read("owner", paused.id))?.goal?.status).toBe("paused");
        expect((await ledger.get("owner", paused.id)).state).toBe("cancelled");
      }
      await expect(app.get("other", s.id)).rejects.toThrow("notFound");
      expect((await app.questions.pending("owner", s.id))!.id).toBe(questionId);
      expect(await app.scheduling.claim(50000)).toBeNull();
      await app.questions.answer("owner", questionId, "c".repeat(64), 50001);
      expect((await personal.questions.pending("owner", s.id))!.state).toBe("pending");
      const claim = await app.scheduling.claim(50002);
      expect(claim!.task.generation).toBe(2);
      await app.cancel("owner", s.id, 50003);
      await expect(app.bind(claim!.lease, "late", "late", 50004)).rejects.toThrow("leaseLost");
      const retryId = randomUUID();
      await app.retry("owner", s.id, retryId, 50005);
      await app.retry("owner", s.id, retryId, 50006);
      const next = await app.scheduling.claim(50007),
        execution = await app.bind(next!.lease, "session-2", "run-2", 50007),
        q = await app.register(execution, "d".repeat(64), 50008);
      await app.questions.answer("owner", q.id, "e".repeat(64), 50009);
      const q2 = await app.register(execution, "f".repeat(64), 50010);
      expect(q2.state).toBe("pending");
      await app.cancel("owner", s.id, 50011);
      expect((await app.questions.get("owner", q2.id)).state).toBe("expired");
      expect(
        (await f.sql`SELECT pendingTaskId FROM panda_force_creation_questions WHERE namespace='application'`).every(
          (q: any) => q.pendingTaskId === null,
        ),
      ).toBe(true);
      expect((await personal.get("owner", s.id)).cancelRequested).toBe(false);
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
test.skipIf(!enabled)(
  "creation MySQL transactions coalesce submission/claims and roll back namespace mutations",
  async () => {
    const f = await isolatedMySQLDatabase("creation");
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(f.sql));
      const first = new MySQLCreationLedger(f.sql, "application"),
        second = new MySQLCreationLedger(f.sql, "application"),
        s = spec();
      const created = await Promise.all([first.create(s, 10000), second.create(s, 10000)]);
      expect(created[0]).toEqual(created[1]);
      const claims = await Promise.allSettled([
        first.claim("owner", s.id, 10001, 30000),
        second.claim("owner", s.id, 10001, 30000),
      ]);
      expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lease = (claims.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value,
        execution = await first.bind(lease, "session", "run", 10001);
      await first.progress.record(lease, { at: 10001, generation: lease.generation, stage: "started" });
      await second.progress.record(lease, {
        at: 10002,
        generation: lease.generation,
        stage: "message",
        text: "Writing requirements",
      });
      expect(
        (await new MySQLCreationLedger(f.sql, "application").progress.list("owner", s.id)).map((event) => event.stage),
      ).toEqual(["started", "message"]);
      expect((await first.progress.list("owner", s.id, false)).map((event) => event.stage)).toEqual(["started"]);
      await expect(first.progress.list("other", s.id)).rejects.toThrow("notFound");
      expect((await second.list("owner")).map((task) => task.spec.id)).toContain(s.id);
      expect(await second.list("other")).toEqual([]);
      const questions = await Promise.allSettled([
        first.register(execution, "b".repeat(64), 10002),
        second.register(execution, "c".repeat(64), 10002),
      ]);
      expect(questions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await first.cancel("owner", s.id, 10003);
      await expect(
        first.transaction(async () => {
          await first.retry("owner", s.id, randomUUID(), 10004);
          throw Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await second.get("owner", s.id)).state).toBe("cancelled");
      await first.retry("owner", s.id, randomUUID(), 10005);
      const next = await second.scheduling.claim(10006),
        scope = await second.bind(next!.lease, "session2", "run2", 10006);
      await first.admit(scope, "d".repeat(64), 10007);
      await first.cancel("owner", s.id, 10008);
      const artifact = {
        kind: "document" as const,
        projectId: "project-1",
        documentId: "document-1",
        operationId: s.operationId,
        treeVersion: 1,
      };
      const done = await first.complete("owner", s.id, "d".repeat(64), artifact, 10009);
      expect(done.state).toBe("cancelled");
      expect(done.artifact).toEqual(artifact);
      expect(await second.complete("owner", s.id, "d".repeat(64), artifact, 10010)).toEqual(done);
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "a plain creation reply is atomic, idempotent and stays out of MySQL artifact completion notifications",
  async () => {
    const f = await isolatedMySQLDatabase("creation");
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(f.sql));
      const ledger = new MySQLCreationLedger(f.sql, "application"),
        reader = new MySQLCreationLedger(f.sql, "application"),
        task = spec();
      await ledger.create(task, 10000);
      const lease = await ledger.claim("owner", task.id, 10001, 30000);
      await ledger.bind(lease, "session", "run", 10002);
      await expect(
        ledger.transaction(async () => {
          expect(await ledger.scheduling.reply(lease, "Rolled back", 10003)).toBe(true);
          throw Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await reader.get("owner", task.id)).state).toBe("running");
      expect(await reader.progress.list("owner", task.id)).toEqual([]);
      expect(await ledger.scheduling.reply(lease, "The classification came from the brief.", 10004)).toBe(true);
      expect(await reader.scheduling.reply(lease, "Duplicate", 10005)).toBe(false);
      const saved = await reader.get("owner", task.id);
      expect(saved.state).toBe("replied");
      expect(saved.artifact).toBeNull();
      expect((await reader.progress.list("owner", task.id)).map(({ stage, text }) => ({ stage, text }))).toEqual([
        { stage: "reply", text: "The classification came from the brief." },
      ]);
      expect(await reader.progress.list("owner", task.id, false)).toEqual([]);
      const [notifications] = await f.sql`SELECT COUNT(*) AS count FROM panda_force_creation_notifications`;
      expect(Number(notifications?.count)).toBe(0);
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "creation message ordering, dispatch recovery and output fencing remain transactional in MySQL",
  async () => {
    const f = await isolatedMySQLDatabase("messages");
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(f.sql));
      const ledger = new MySQLCreationLedger(f.sql, "application"),
        s = spec();
      await ledger.create(s, 10000);
      const lease = await ledger.claim("owner", s.id, 10001, 30000),
        execution = await ledger.bind(lease, "session", "run", 10002);
      const first = {
        id: "ffffffff-ffff-4fff-afff-ffffffffffff",
        owner: "owner",
        taskId: s.id,
        generation: lease.generation,
        requestDigest: "b".repeat(64),
        payloadDigest: "c".repeat(64),
        state: "received" as const,
        dispatchGeneration: null,
        createdAt: 10003,
        updatedAt: 10003,
      };
      const second = { ...first, id: "00000000-0000-4000-a000-000000000000", requestDigest: "d".repeat(64) };
      await ledger.messages.accept(first);
      await ledger.messages.accept(second);
      expect((await ledger.messages.list("owner", s.id)).map((message) => message.id)).toEqual([first.id, second.id]);
      expect((await ledger.messages.accept(first)).id).toBe(first.id);
      await expect(ledger.admit({ ...execution, contextVersion: first.id }, "e".repeat(64), 10005)).rejects.toThrow(
        "conflict",
      );
      expect((await ledger.messages.claim(lease, 10006))!.id).toBe(first.id);
      await ledger.scheduling.release(lease, 10007);
      const next = await ledger.claim("owner", s.id, 10008, 30000),
        scope = await ledger.bind(next, "next-session", "next-run", 10009);
      expect((await ledger.messages.claim(next, 10010))!.id).toBe(second.id);
      expect((await ledger.messages.find("owner", first.id))!.state).toBe("uncertain");
      await ledger.messages.settle(lease, first.id, "delivered", 10011);
      expect((await ledger.messages.find("owner", first.id))!.state).toBe("uncertain");
      await ledger.messages.seen(next, [first.id, second.id], 10012);
      expect((await ledger.admit({ ...scope, contextVersion: second.id }, "f".repeat(64), 10013)).state).toBe(
        "committing",
      );
      await expect(ledger.messages.accept({ ...first, id: randomUUID() })).rejects.toThrow("conflict");
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "creation goals retain owner isolation, atomic pause/resume and save fences in MySQL",
  async () => {
    const f = await isolatedMySQLDatabase("goals");
    try {
      const registry = new DatabaseRegistry().register(mysqlCreationModule),
        schema = new MySQLSchemaConnection(f.sql);
      await registry.upgrade(schema);
      expect(await mysqlCreationModule.inspect(schema)).toEqual([]);
      const app = new MySQLCreationLedger(f.sql, "application"),
        other = new MySQLCreationLedger(f.sql, "personal:other"),
        s = spec();
      await app.create(s, 10000);
      await other.create(s, 10000);
      const lease = await app.claim("owner", s.id, 10001, 30000),
        scope = await app.bind(lease, "session", "run", 10001);
      const created = await app.goals.command(
        "owner",
        s.id,
        { id: randomUUID(), action: "create", objective: "Include field inheritance" },
        10002,
        scope,
      );
      expect(await other.goals.read("owner", s.id)).toBeNull();
      await expect(app.goals.read("different-owner", s.id)).rejects.toThrow("notFound");
      await expect(app.admit(scope, "b".repeat(64), 10003)).rejects.toThrow("conflict");
      const pause = { id: randomUUID(), action: "pause" as const };
      expect((await app.goals.command("owner", s.id, pause, 10004)).goal?.status).toBe("paused");
      expect((await app.get("owner", s.id)).state).toBe("cancelled");
      await expect(
        app.goals.command(
          "owner",
          s.id,
          { id: randomUUID(), action: "create", objective: "Stale model target" },
          10005,
          scope,
        ),
      ).rejects.toThrow("leaseLost");
      const resume = { id: randomUUID(), action: "resume" as const };
      const resumed = await app.goals.command("owner", s.id, resume, 10006);
      expect((await app.goals.command("owner", s.id, resume, 10007)).at).toBe(resumed.at);
      const next = await app.claim("owner", s.id, 10008, 30000),
        nextScope = await app.bind(next, "session-next", "run-next", 10008);
      const goal = await app.goals.read("owner", s.id);
      expect(goal?.goal?.id).toBe(created.goal?.id);
      expect((await app.admit({ ...nextScope, goalVersion: goal!.at }, "b".repeat(64), 10009)).state).toBe(
        "committing",
      );
      await expect(
        app.goals.command(
          "owner",
          s.id,
          { id: randomUUID(), action: "set", objective: "Too late to change admitted output" },
          10010,
        ),
      ).rejects.toThrow("conflict");
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "creation MySQL retains typed asset receipts and rejects a different completed output",
  async () => {
    const f = await isolatedMySQLDatabase("creation");
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(f.sql));
      for (const kind of ["image", "slides", "video", "web"] as const) {
        const s = { ...spec(), kind },
          ledger = new MySQLCreationLedger(f.sql, "typed-assets");
        await ledger.create(s, 1);
        const scope = await ledger.bind(await ledger.claim(s.owner, s.id, 2, 30000), "owned-session", "owned-run", 3),
          receipt = {
            kind,
            projectId: s.projectId,
            operationId: s.operationId,
            assetId: "c-" + s.operationId,
            version: "b".repeat(64),
            commit: "c".repeat(40),
            title: "Saved original",
            source: { name: "original.bin", digest: "d".repeat(64), size: 123 },
          };
        await ledger.admit(scope, "f".repeat(64), 4);
        await expect(
          ledger.complete(
            s.owner,
            s.id,
            "f".repeat(64),
            {
              kind: "document",
              projectId: s.projectId,
              operationId: s.operationId,
              documentId: "wrong-document",
              treeVersion: 1,
            },
            5,
          ),
        ).rejects.toThrow();
        expect((await ledger.get(s.owner, s.id)).state).toBe("committing");
        await ledger.complete(s.owner, s.id, "f".repeat(64), receipt, 5);
        expect((await new MySQLCreationLedger(f.sql, "typed-assets").get(s.owner, s.id)).artifact).toEqual(receipt);
      }
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "shared creation facets roll back messages, goals and progress with their task",
  async () => {
    const f = await isolatedMySQLDatabase("creation");
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(f.sql));
      const ledger = new MySQLCreationLedger(f.sql, "shared-facet-rollback"),
        s = spec(),
        messageId = randomUUID();
      await expect(
        ledger.transaction(async () => {
          await ledger.create(s, 10000);
          await ledger.goals.command(
            s.owner,
            s.id,
            { id: randomUUID(), action: "create", objective: "Atomic goal" },
            10000,
          );
          const lease = await ledger.claim(s.owner, s.id, 10001, 30000);
          await ledger.messages.accept({
            id: messageId,
            taskId: s.id,
            owner: s.owner,
            generation: lease.generation,
            requestDigest: "b".repeat(64),
            payloadDigest: "c".repeat(64),
            state: "received",
            dispatchGeneration: null,
            createdAt: 10002,
            updatedAt: 10002,
          });
          await ledger.progress.record(lease, { generation: lease.generation, at: 10002, stage: "started" });
          throw Error("rollback-all-facets");
        }),
      ).rejects.toThrow("rollback-all-facets");
      expect(await ledger.find(s.owner, s.id)).toBeNull();
      expect(await ledger.messages.find(s.owner, messageId)).toBeNull();
      await ledger.create(s, 10003);
      expect(await ledger.goals.read(s.owner, s.id)).toBeNull();
      expect(await ledger.progress.list(s.owner, s.id)).toEqual([]);
    } finally {
      await f.close();
    }
  },
  60000,
);
