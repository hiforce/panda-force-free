import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { MySQLCreationLedger } from "../../src/server/creation/storage/mysql.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import type { CreationTaskSpec, CreationDocumentArtifact } from "../../src/server/creation/contracts.js";
import type { CreationNotificationRecord } from "../../src/server/creation/ports.js";
for (const backend of ["sqlite", "mysql"] as const)
  test.skipIf(backend === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${backend} commits exactly one completion receipt atomically and excludes cancelled saves`,
    async () => {
      const remote = backend === "mysql" ? await isolatedMySQLDatabase("notices") : null,
        db = remote ? null : openCreationDatabase(":memory:");
      try {
        if (remote)
          await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(remote.sql));
        const store = remote ? new MySQLCreationLedger(remote.sql, "application") : new CreationTaskRepository(db!);
        const spec: CreationTaskSpec = {
          schema: 1,
          id: randomUUID(),
          owner: "owner",
          projectId: "project-1",
          operationId: randomUUID(),
          kind: "document",
          target: { parentId: null, treeVersion: 0, locale: "en" },
          inputDigest: "a".repeat(64),
          skillCaptureId: null,
        };
        const artifact: CreationDocumentArtifact = {
            kind: "document",
            projectId: spec.projectId,
            operationId: spec.operationId,
            documentId: "document-1",
            treeVersion: 1,
          },
          digest = "d".repeat(64);
        await store.create(spec, 1000);
        const committing = async (id: string, cancelled = false) => {
          if (remote)
            await remote.sql`UPDATE panda_force_creation_tasks SET state='committing',generation=1,outputDigest=${digest},cancelRequested=${Number(cancelled)} WHERE namespace='application' AND id=${id}`;
          else
            db!
              .query(
                "UPDATE creation_tasks SET state='committing',generation=1,outputDigest=?,cancelRequested=? WHERE id=?",
              )
              .run(digest, Number(cancelled), id);
        };
        await committing(spec.id);
        if (remote) {
          await expect(
            (store as MySQLCreationLedger).transaction(async () => {
              await store.complete(spec.owner, spec.id, digest, artifact, 1001);
              throw Error("rollback");
            }),
          ).rejects.toThrow("rollback");
        } else
          expect(() =>
            db!.transaction(() => {
              (store as CreationTaskRepository).complete(spec.owner, spec.id, digest, artifact, 1001);
              throw Error("rollback");
            })(),
          ).toThrow("rollback");
        expect(await store.notifications(spec.owner)).toEqual([]);
        expect((await store.get(spec.owner, spec.id)).artifact).toBeNull();
        await store.complete(spec.owner, spec.id, digest, artifact, 1002);
        await store.complete(spec.owner, spec.id, digest, artifact, 1003);
        expect(await store.notifications(spec.owner)).toEqual([
          { taskId: spec.id, generation: 1, createdAt: 1002, readAt: null },
        ]);
        await store.readNotification(spec.owner, spec.id, 1, 1004);
        await store.readNotification(spec.owner, spec.id, 1, 1005);
        expect((await store.notifications(spec.owner))[0]!.readAt).toBe(1004);
        expect(await store.notifications("another")).toEqual([]);
        const other = { ...spec, id: randomUUID(), operationId: randomUUID() };
        await store.create(other, 1006);
        await committing(other.id, true);
        await store.complete(other.owner, other.id, digest, { ...artifact, operationId: other.operationId }, 1007);
        expect(await store.notifications(spec.owner)).toHaveLength(1);
        for (let index = 0; index < 103; index++) {
          const next = { ...spec, id: randomUUID(), operationId: randomUUID() };
          await store.create(next, 2000);
          await committing(next.id);
          await store.complete(
            next.owner,
            next.id,
            digest,
            { ...artifact, operationId: next.operationId },
            2000 + Math.floor(index / 3),
          );
        }
        expect(await store.notifications(spec.owner)).toHaveLength(100);
        const paged: CreationNotificationRecord[] = [];
        for (;;) {
          const page = await store.notifications(spec.owner, { limit: 12, before: paged.at(-1) });
          paged.push(...page);
          if (page.length < 12) break;
        }
        expect(new Set(paged.map(({ taskId }) => taskId)).size).toBe(104);
        expect(paged.at(-1)?.taskId).toBe(spec.id);
        expect(await store.notifications("another", { limit: 12, before: paged[0] })).toEqual([]);
      } finally {
        db?.close();
        await remote?.close();
      }
    },
    60000,
  );
