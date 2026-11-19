import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { CreationQueue } from "../../src/server/creation/storage/queue.js";
import { createMySQLCreationStorage } from "../../src/server/creation/storage/mysql.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import type { CreationTaskSpec, CreationArtifact } from "../../src/server/creation/contracts.js";
for (const backend of ["sqlite", "mysql"] as const)
  test.skipIf(backend === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${backend} creation identity spans native outputs, branches, long history and reversible history clearing`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "creation-lineage-")),
        db = openCreationDatabase(join(dir, "creation.sqlite")),
        mysql = backend === "mysql" ? await isolatedMySQLDatabase("lineage") : null;
      try {
        db.exec("PRAGMA synchronous=OFF");
        if (mysql)
          await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        const tasks = new CreationTaskRepository(db),
          store = mysql
            ? createMySQLCreationStorage(mysql.sql, "application")
            : { tasks, queue: new CreationQueue(db, tasks) };
        const create = async (
          at: number,
          previousTaskId?: string,
          kind: CreationTaskSpec["kind"] = "image",
          creationKey?: string,
          owner = "owner",
          projectId = "project",
          active = false,
        ) => {
          const id = randomUUID(),
            spec: CreationTaskSpec = {
              schema: 1,
              id,
              owner,
              projectId,
              operationId: randomUUID(),
              kind,
              target: { treeVersion: 0, parentId: null, locale: "en" },
              inputDigest: "a".repeat(64),
              skillCaptureId: null,
              ...(previousTaskId ? { previousTaskId } : {}),
              ...(creationKey ? { creationKey } : {}),
            };
          await store.tasks.create(spec, at);
          if (!active) {
            const lease = await store.tasks.claim(owner, id, at + 1, 30000),
              scope = { ...lease, sessionId: randomUUID(), runId: randomUUID() };
            await store.tasks.bind(lease, scope.sessionId, scope.runId, at + 2);
            await store.tasks.admit(scope, "b".repeat(64), at + 3);
            const artifact: CreationArtifact =
              kind === "document"
                ? {
                    kind: "document",
                    projectId,
                    documentId: randomUUID(),
                    operationId: spec.operationId,
                    treeVersion: 1,
                  }
                : {
                    kind: kind as "image",
                    projectId,
                    assetId: "c-" + spec.operationId,
                    operationId: spec.operationId,
                    version: "c".repeat(64),
                    commit: "d".repeat(40),
                    title: "Native result",
                    source: { name: "result.png", size: 100, digest: "e".repeat(64) },
                  };
            await store.tasks.complete(owner, id, "b".repeat(64), artifact, at + 4);
          }
          return id;
        };
        const legacyRoot = await create(10, undefined, "document", undefined, "legacy"),
          legacyUpdate = await create(20, legacyRoot, "document", undefined, "legacy");
        for (let repeat = 0; repeat < 5; repeat++) {
          const legacyRows = await store.queue.list("legacy");
          expect(legacyRows).toHaveLength(1);
          expect(legacyRows[0]!.history).toEqual({ rootId: legacyRoot, createdAt: 10, rounds: 2 });
          expect((await store.queue.rounds("legacy", legacyRoot)).rootId).toBe(legacyRoot);
        }
        await store.queue.clearHistory("legacy", { id: randomUUID(), taskId: legacyRoot, before: 11 }, 30);
        expect((await store.queue.list("legacy"))[0]!.spec.id).toBe(legacyUpdate);
        expect((await store.queue.list("legacy"))[0]!.history!.rootId).toBe(legacyRoot);
        expect((await store.tasks.get("legacy", legacyRoot)).artifact).toBeTruthy();
        await store.queue.clearHistory("legacy", { id: randomUUID(), before: 30 }, 40);
        expect(await store.queue.list("legacy")).toEqual([]);
        expect((await store.queue.rounds("legacy", legacyUpdate)).ids).toEqual([legacyUpdate, legacyRoot]);
        const continued = await create(50, legacyUpdate, "document", undefined, "legacy");
        expect((await store.queue.list("legacy"))[0]!.spec.id).toBe(continued);
        expect((await store.queue.list("legacy"))[0]!.history!.rootId).toBe(legacyRoot);
        const root = await create(100),
          ids = [root],
          other = await create(50);
        let previous = root;
        for (let i = 1; i < 55; i++) {
          previous = await create(
            100 + i * 10,
            previous,
            (["image", "video", "slides", "web", "document"] as const)[i % 5],
            i < 25 ? undefined : "t:" + root,
          );
          ids.push(previous);
        }
        const rows = await store.queue.list("owner");
        expect(rows.map((t) => t.spec.id)).toEqual([previous, other]);
        expect(rows[0]!.history).toEqual({ rootId: root, createdAt: 100, rounds: 55 });
        const found: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await store.queue.rounds("owner", root, cursor);
          expect(page.rootId).toBe(root);
          expect(page.latestTaskId).toBe(previous);
          found.push(...page.ids);
          cursor = page.nextCursor || undefined;
        } while (cursor);
        expect(found).toEqual([...ids].reverse());
        const active = await create(1000, root, "video", "t:" + root, "owner", "project", true),
          branch = await create(1100, root, "slides", "t:" + root);
        expect((await store.queue.list("owner"))[0]!.spec.id).toBe(active);
        expect((await store.queue.rounds("owner", previous)).ids).toContain(branch);
        const foreign = await create(1200, root, "image", undefined, "foreign"),
          project = await create(1300, root, "image", undefined, "owner", "other-project");
        expect((await store.queue.list("foreign"))[0]!.history!.rootId).toBe(foreign);
        expect((await store.queue.list("owner", "other-project"))[0]!.history!.rootId).toBe(project);
        const clear = { id: randomUUID(), taskId: previous, before: 1000 },
          receipt = await store.queue.clearHistory("owner", clear, 2000);
        expect(receipt.hidden).toBe(55);
        expect(await store.queue.clearHistory("owner", clear, 3000)).toEqual(receipt);
        expect((await store.queue.rounds("owner", root)).rounds).toBe(57);
        expect((await store.tasks.get("owner", active)).cancelRequested).toBe(false);
        expect((await store.tasks.get("owner", root)).artifact).toBeTruthy();
        expect((await store.queue.list("owner")).map((t) => t.spec.id)).toContain(active);
        await expect(Promise.resolve().then(() => store.queue.rounds("foreign", root))).rejects.toThrow("notFound");
      } finally {
        db.close();
        await mysql?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120000,
  );
