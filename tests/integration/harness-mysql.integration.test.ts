import {
  memoryFixtureOrganizer,
  memoryFixturePolicy,
  runDueMemory,
  stageCompletedMemory,
} from "../support/memory-organization.js";
import { randomUUID } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { migrateHarnessSnapshot } from "../../src/server/harness/storage/migrate.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { save } from "../../src/server/harness/records.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import type { ModelReviewPort } from "../../src/server/project-memory/model-review.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "Harness metadata migrates without transcript copies, fences concurrent revisions and keeps defaults after reopen",
  async () => {
    const fixture = await isolatedMySQLDatabase("harness"),
      root = await mkdtemp(join(tmpdir(), "panda-harness-mysql-")),
      path = join(root, "source.sqlite");
    const source = new SQLiteHarnessMetadata(path);
    try {
      const schema = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlHarnessModule);
      await schema.upgrade(new MySQLSchemaConnection(fixture.sql));
      await source.transaction(async (tx) => {
        await tx.put(
          {
            id: "sample",
            kind: "conversation",
            owner: "one",
            revision: 1,
            updatedAt: 1,
            data: JSON.stringify({ historyBytes: 900, bindings: [] }),
          },
          null,
        );
      });
      await source.close();
      const snapshot = join(root, "snapshot.sqlite"),
        db = new Database(path, { readonly: true });
      try {
        db.query("VACUUM INTO ?").run(snapshot);
      } finally {
        db.close();
      }
      await chmod(snapshot, 0o400);
      await migrateHarnessSnapshot({ sql: fixture.sql, snapshotPath: snapshot, migrationId: "harness-import" });
      const a = new MySQLHarnessMetadata(fixture.sql),
        b = new MySQLHarnessMetadata(fixture.sql);
      expect(JSON.parse((await a.read("sample"))!.data).historyBytes).toBe(900);
      expect(await a.list("conversation", "two")).toEqual([]);
      const changes = await Promise.allSettled(
        [a, b].map((store) =>
          store.transaction(async (tx) => {
            const row = (await tx.get("sample"))!;
            await Bun.sleep(15);
            await tx.put({ ...row, revision: 2 }, 1);
          }),
        ),
      );
      expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter((result) => result.status === "rejected")).toHaveLength(1);
      const history = new JsonlHarnessHistory(join(root, "memory-history"));
      const memory = new ProjectMemory(
        a,
        history,
        async () => {},
        undefined,
        undefined,
        undefined,
        memoryFixtureOrganizer,
      );
      const sourceId = randomUUID();
      const messageId = randomUUID(),
        runId = randomUUID();
      const text = "Project convention [release]: artifact retention = 30 days";
      const historyBytes = await history.append("one", sourceId, 0, [
        {
          type: "message",
          seq: 1,
          message: {
            id: messageId,
            seq: 1,
            role: "user",
            text,
            runId,
            runtimeId: "codex",
            model: null,
            attachments: [],
            status: "complete",
            createdAt: Date.now(),
          },
        },
        {
          type: "message",
          seq: 2,
          message: {
            id: randomUUID(),
            seq: 2,
            role: "assistant",
            text: "",
            runId: randomUUID(),
            runtimeId: "codex",
            model: null,
            attachments: [],
            status: "running",
            createdAt: Date.now(),
          },
        },
      ]);
      const conversation = {
        id: sourceId,
        owner: "one",
        projectId: "atlas",
        revision: 0,
        cwd: root,
        archivedAt: null,
        historyBytes,
        lastSeq: 2,
      };
      await memory.configure("one", "atlas", { revision: 0, write: true, recall: true, model: memoryFixturePolicy });
      await a.transaction(async (tx) => {
        await save(tx, "conversation:" + sourceId, "conversation", "one", conversation);
        await stageCompletedMemory(tx, memory, conversation, { id: messageId, runId, seq: 1 });
      });
      await runDueMemory(a, memory);
      const entries = await memory.catalog("one", "atlas");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ state: "active", value: "30 days", sources: [{ messageId }] });
      expect(await memory.catalog("two", "atlas")).toEqual([]);
      const terrain = await new ProjectMemory(b, history, async () => {}).terrain("one", "atlas");
      expect(terrain.places).toEqual([{ slot: 0, entry: entries[0] }]);
      expect(await memory.terrain("two", "atlas", terrain.topic!, terrain.plate!)).toMatchObject({
        topics: [],
        places: [],
        plates: [],
      });
      expect(await memory.terrain("one", "different-project")).toMatchObject({ topics: [], places: [] });
      expect(await memory.sourceMessage("one", "atlas", sourceId, messageId)).toEqual({ text });
      expect(await memory.sourceLocation("one", "atlas", sourceId, messageId)).toMatchObject({
        message: { id: messageId, text, sequence: 1 },
      });
      await expect(memory.sourceLocation("two", "atlas", sourceId, messageId)).rejects.toMatchObject({ status: 404 });
      await expect(memory.sourceLocation("one", "atlas", sourceId, randomUUID())).rejects.toMatchObject({
        status: 404,
      });
      await expect(memory.sourceMessage("one", "different-project", sourceId, messageId)).rejects.toMatchObject({
        status: 404,
      });
      const archive = await memory.exportArchive("one", "atlas");
      const preview = await memory.archiveImport("one", "copy", archive, undefined, async () => {});
      if (!("token" in preview)) throw Error("Missing archive preview");
      const another = new ProjectMemory(b, history, async () => {});
      const imports = await Promise.all(
        [memory, another].map((worker) => worker.archiveImport("one", "copy", archive, preview.token, async () => {})),
      );
      expect(imports[0]).toEqual(imports[1]);
      expect(await another.catalog("one", "copy")).toMatchObject([{ value: "30 days", packages: [archive.packageId] }]);
      await expect(memory.archiveImport("two", "copy", archive, undefined, async () => {})).rejects.toMatchObject({
        status: 403,
      });
      await another.withdrawArchive("one", "copy", archive.packageId);
      expect(await memory.catalog("one", "copy")).toEqual([]);
      await expect(memory.archiveImport("one", "copy", archive, preview.token, async () => {})).rejects.toMatchObject({
        status: 409,
      });
      await b.transaction(async (tx) => {
        await save(tx, "conversation:" + sourceId, "conversation", "one", { ...conversation, archivedAt: Date.now() });
        await memory.retract(tx, conversation);
      });
      expect(await memory.catalog("one", "atlas")).toEqual([]);
      expect(await memory.terrain("one", "atlas", terrain.topic!, terrain.plate!)).toMatchObject({
        topics: [],
        places: [],
        plates: [],
      });
      await expect(memory.sourceMessage("one", "atlas", sourceId, messageId)).rejects.toMatchObject({ status: 404 });
      await memory.processPending();
      expect(await a.list("project-memory-evidence")).toEqual([]);
      const modelId = randomUUID();
      const modelMessageId = randomUUID();
      const modelText = "The release artifact stays available for one month.";
      const modelRunId = randomUUID();
      const modelBytes = await history.append("one", modelId, 0, [
        {
          type: "message",
          seq: 1,
          message: {
            id: modelMessageId,
            seq: 1,
            role: "user",
            text: modelText,
            runId: modelRunId,
            runtimeId: "codex",
            model: null,
            attachments: [],
            status: "complete",
            createdAt: Date.now(),
          },
        },
      ]);
      const modelConversation = { ...conversation, id: modelId, historyBytes: modelBytes };
      let now = Date.now(),
        modelCalls = 0;
      const models: ModelReviewPort = {
        resolve: async (_owner, selection) => selection,
        async review() {
          throw Error("Retired reviewer was invoked.");
        },
        async organize(_owner, _selection, context) {
          modelCalls++;
          expect(context.sources[0]?.user).toBe(modelText);
          return [];
        },
      };
      const modelWorker = (metadata: MySQLHarnessMetadata) =>
        new ProjectMemory(
          metadata,
          history,
          async () => {},
          undefined,
          () => now,
          undefined,
          models,
        );
      const worker = modelWorker(a);
      await worker.configure("one", "atlas", {
        revision: 1,
        write: true,
        recall: true,
        model: { enabled: true, selection: { runtimeId: "codex", model: "fixture", effort: "low" } },
      });
      await a.transaction(async (tx) => {
        await save(tx, "conversation:" + modelId, "conversation", "one", modelConversation);
        await stageCompletedMemory(tx, worker, modelConversation, { id: modelMessageId, runId: modelRunId, seq: 1 });
      });
      now += 301_000;
      await Promise.all([worker.processPending(), modelWorker(b).processPending()]);
      expect(modelCalls).toBe(1);
      expect((await worker.contributions(modelConversation)).pending).toBe(0);
      await b.transaction((tx) =>
        worker.configureSource(tx, modelConversation, { revision: 0, write: null, recall: null, revoke: true }),
      );
      expect(await modelWorker(b).modelReviews("one", "atlas")).toEqual([]);
      await worker.processPending();
      expect(await a.list("project-memory-model-review")).toEqual([]);
      const profiles = [
        {
          id: "codex",
          name: "Codex",
          kind: "codex" as const,
          deployment: "local" as const,
          factory: {
            create: async () => {
              throw Error("notUsed");
            },
          },
        },
      ];
      const registry = new HarnessRegistry(a, profiles);
      await registry.initialize();
      const administrator = { owner: "one", administrator: true },
        catalog = await registry.catalog(administrator),
        runtime = catalog.runtimes[0]!;
      await registry.configure(administrator, { ...runtime, name: "Renamed", makeDefault: true });
      const reopened = new HarnessRegistry(b, profiles);
      await reopened.initialize();
      expect((await reopened.catalog(administrator)).runtimes[0]!.name).toBe("Renamed");
      expect(await schema.inspect(new MySQLSchemaConnection(fixture.sql))).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
