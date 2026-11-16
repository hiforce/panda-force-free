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
        s = spec();
      let questionId = "";
      for (const path of paths) {
        const db = openCreationDatabase(path.snapshotPath);
        try {
          const tasks = new CreationTaskRepository(db),
            questions = new CreationQuestionRepository(db, tasks);
          tasks.create(s, 10000);
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
