import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlKnowledgeModule } from "../../src/server/database/modules/knowledge.js";
import { mysqlSearchModule } from "../../src/server/database/modules/search.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { migrateKnowledgeSnapshot } from "../../src/server/knowledge/storage/mysql-migration.js";
import { migrateSearchSnapshot } from "../../src/server/search/storage/mysql-migration.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { createMySQLSearchPersistence } from "../../src/server/search/storage/mysql.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import { createMySQLKnowledgePersistence } from "../../src/server/knowledge/storage/mysql.js";
import { MySQLMetadataContext } from "../../src/server/knowledge/storage/mysql-context.js";
import { MySQLSearchSourceRegistry } from "../../src/server/search/storage/mysql-registry.js";
import { MySQLSearchAudits } from "../../src/server/search/storage/mysql-audits.js";
import { MySQLSearchJobs } from "../../src/server/search/storage/mysql-jobs.js";
import { MySQLSearchIndexResources } from "../../src/server/search/storage/mysql-resources.js";
import { MySQLSearchResourceScans } from "../../src/server/search/storage/mysql-resource-scans.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
const guarded = test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
const submission = (owner = "owner-a", operationId = randomUUID()) => ({
  owner,
  project: "personal",
  title: "Owned task",
  operationId,
  requestHash: "a".repeat(64),
  signature: randomUUID(),
  inputDigest: "b".repeat(64),
  dialogueDigest: "c".repeat(64),
});
guarded(
  "knowledge snapshots preserve relational history, replay/owner fences, guarded rollback, independent review and native leases",
  async () => {
    const fixture = await isolatedMySQLDatabase("knowledge"),
      root = await mkdtemp(join(tmpdir(), "knowledge-mysql-"));
    try {
      const path = join(root, "knowledge.sqlite"),
        source = openKnowledgeDatabase(path),
        sqlite = knowledgeTaskLedger(source),
        input = submission(),
        saved = sqlite.create(input, 100);
      const completedInput = submission("catalog-owner"),
        completed = sqlite.create(completedInput, 1),
        execution = sqlite.claim(2, 1000)!;
      const completedScope = sqlite.bind(execution.lease, { sessionId: "catalog-session", runId: "catalog-run" }, 2);
      sqlite.draft(completedScope, "d".repeat(64), 3);
      sqlite.admit(completed.owner, completed.id, 1, "e".repeat(64), 4);
      const receipt = { id: "k-approved", version: "f".repeat(64), commit: "1".repeat(40) },
        projection = {
          schema: 1 as const,
          id: receipt.id,
          version: receipt.version,
          taskId: completed.id,
          sourceCommit: "2".repeat(40),
          recordBlob: "3".repeat(40),
          markdownBlob: "4".repeat(40),
          sources: [{ id: "source-one", version: "saved-one", blob: "5".repeat(40) }],
        };
      sqlite.complete(completed.owner, completed.id, "e".repeat(64), receipt, 5, projection);
      source.close();
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlKnowledgeModule),
        schema = new MySQLSchemaConnection(fixture.sql);
      await registry.upgrade(schema);
      await migrateKnowledgeSnapshot({ sql: fixture.sql, snapshotPath: path, migrationId: "knowledge-v1" });
      await migrateKnowledgeSnapshot({ sql: fixture.sql, snapshotPath: path, migrationId: "knowledge-v1" });
      const first = await createMySQLKnowledgePersistence(fixture.sql),
        second = await createMySQLKnowledgePersistence(fixture.sql);
      expect(await first.ledger.get(input.owner, saved.id)).toEqual(saved);
      const approved = await first.catalog.lookup(completed.owner, "personal", [completed.id]);
      expect(approved.entries).toHaveLength(1);
      expect(approved.entries[0]!.projection).toEqual(projection);
      expect((await first.catalog.lookup("another-owner", "personal", [completed.id])).entries).toEqual([]);
      expect(await first.catalog.save(approved.entries[0]!, projection)).toBe(true);
      expect((await first.catalog.list(completed.owner, "personal")).entries).toHaveLength(1);
      await expect(second.ledger.get("other-owner", saved.id)).rejects.toMatchObject({ code: "notFound" });
      expect((await second.ledger.create(input, 101)).id).toBe(saved.id);
      await expect(first.ledger.create({ ...input, requestHash: "d".repeat(64) }, 102)).rejects.toMatchObject({
        code: "conflict",
      });
      const cancelled = submission();
      await expect(
        first.ledger.create(cancelled, 103, async () => {
          await Promise.resolve();
          throw Error("guard-rejected");
        }),
      ).rejects.toThrow("guard-rejected");
      expect(await first.ledger.submission(cancelled.owner, cancelled.operationId, cancelled.requestHash)).toBeNull();
      const concurrent = submission("owner-b");
      const pair = await Promise.all([first.ledger.create(concurrent, 104), second.ledger.create(concurrent, 105)]);
      expect(pair[0].id).toBe(pair[1].id);
      const page = await first.ledger.page(input.owner, input.project, undefined, 1);
      expect(page.tasks[0]!.id).toBe(saved.id);
      const claimed = await first.ledger.claim(110, 50);
      expect(claimed).not.toBeNull();
      const scope = await first.ledger.bind(claimed!.lease, { sessionId: "session", runId: "run" }, 111);
      await first.ledger.draft(scope, "e".repeat(64), 112);
      await first.reviews.configure(input.owner, input.project, true, 0, 113);
      const reviewed = await first.reviews.claim(114);
      expect(reviewed!.task.id).toBe(saved.id);
      const review = await first.reviews.bind(
        reviewed!.review,
        { sessionId: "review-session", runId: "review-run" },
        115,
      );
      await first.reviews.finish(review, "f".repeat(64), true, 116);
      await first.reviews.configure(input.owner, input.project, false, 1, 117);
      await expect(second.reviews.admit(review, "f".repeat(64), "a".repeat(64), 118)).rejects.toMatchObject({
        code: "conflict",
      });
      await first.ledger.cancel(input.owner, saved.id, 119);
      await expect(first.ledger.assertLease(claimed!.lease, 120)).rejects.toMatchObject({ code: "leaseLost" });
      const generation = first.generation,
        owner = "owner-generation",
        snapshot = {
          commit: "1".repeat(40),
          documents: [
            { id: "document-one", parentId: null, version: "saved-one" },
            { id: "document-two", parentId: null, version: "saved-two" },
          ],
        };
      await generation.configureBudgets({
        installationDaily: 1,
        ownerDaily: 1,
        installationPending: 1,
        ownerPending: 1,
      });
      await generation.policies.configure(
        owner,
        "personal",
        {
          ...defaultGenerationPolicy(),
          enabled: true,
          purpose: "Summarize saved sources",
          selection: { all: true, documents: [], subtrees: [], excludeDocuments: [], excludeSubtrees: [] },
          backfill: true,
        },
        snapshot,
        1000,
      );
      const generated = submission(owner),
        lease = (await generation.queue.claim(2501))!;
      const wrongSource = submission(owner);
      await expect(
        first.ledger.create(wrongSource, 2502, (id, created, now) =>
          generation.admission.admit({ ...lease, source: { ...lease.source, kind: "web" } }, id, created, now),
        ),
      ).rejects.toMatchObject({ code: "leaseLost" });
      expect(await first.ledger.submission(owner, wrongSource.operationId, wrongSource.requestHash)).toBeNull();
      const generatedTask = await first.ledger.create(generated, 2502, (id, created, now) =>
        generation.admission.admit(lease, id, created, now),
      );
      expect((await generation.status.status(owner, "personal", 2503)).pendingTasks).toBe(1);
      expect(await generation.admission.usage(owner, "personal", 2503)).toBe(1);
      expect((await second.ledger.create(generated, 2504)).id).toBe(generatedTask.id);
      expect(await generation.admission.usage(owner, "personal", 2505)).toBe(1);
      const blocked = submission(owner),
        nextLease = (await generation.queue.claim(4503))!;
      await expect(
        first.ledger.create(blocked, 4504, (id, created, now) =>
          generation.admission.admit(nextLease, id, created, now),
        ),
      ).rejects.toMatchObject({ code: "budget" });
      expect(await first.ledger.submission(owner, blocked.operationId, blocked.requestHash)).toBeNull();
      await generation.policies.configure(
        owner,
        "personal",
        { ...defaultGenerationPolicy(), revision: 1, backfill: false },
        null,
        4505,
      );
      expect((await first.ledger.get(owner, generatedTask.id)).state).toBe("queued");
      await first.access.revoke({ owner, project: "personal" }, 4506);
      expect((await generation.status.status(owner, "personal", 4507)).pendingTasks).toBe(0);
      expect((await first.ledger.get(owner, generatedTask.id)).state).toBe("cancelled");
      expect(await generation.auditBudgets()).toEqual({ repaired: false });
      const nativeRoot = join(root, "native-feature"),
        unavailable = async (): Promise<never> => {
          throw Error("Unexpected content or engine access");
        },
        feature = createKnowledgeFeature({
          stateRoot: nativeRoot,
          storage: first,
          content: { authorize: async () => {}, capture: unavailable, current: async () => false, save: unavailable },
          profile: unavailable,
          engine: () => {
            throw Error("Unexpected engine access");
          },
          available: () => false,
          owner: () => owner,
          report: () => {},
        });
      try {
        expect((await feature.service.list(input.owner, "personal")).some((row) => row.id === saved.id)).toBe(true);
        expect(await Bun.file(join(nativeRoot, "data", "knowledge.sqlite")).exists()).toBe(false);
      } finally {
        await feature.close();
      }
      expect(await registry.inspect(schema)).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
guarded(
  "search snapshots preserve configured identities and keep resource read, deletion and uncertain-reference fences native",
  async () => {
    const fixture = await isolatedMySQLDatabase("search"),
      root = await mkdtemp(join(tmpdir(), "search-mysql-"));
    try {
      const path = join(root, "search.sqlite"),
        source = openSearchDatabase(path);
      const instance = (source.query("SELECT value FROM search_meta WHERE id='instance'").get() as { value: string })
        .value;
      source.close();
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlSearchModule),
        schema = new MySQLSchemaConnection(fixture.sql);
      await registry.upgrade(schema);
      await migrateSearchSnapshot({ sql: fixture.sql, snapshotPath: path, migrationId: "search-v1" });
      const db = new MySQLMetadataContext(fixture.sql, "search"),
        sources = new MySQLSearchSourceRegistry(db);
      expect((await sources.binding()).source).toBe("builtin");
      expect(
        (await db.one<{ value: string }>("SELECT value FROM panda_force_search_meta WHERE id='instance'"))!.value,
      ).toBe(instance);
      let now = 1000;
      const jobs = new MySQLSearchJobs(db, () => now),
        resources = new MySQLSearchIndexResources(db, () => now);
      const scope = { owner: "owner-a", project: "personal", source: "builtin" };
      const configured = await jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
      expect(configured.owner).toBe(scope.owner);
      expect(await jobs.get({ ...scope, owner: "other-owner" })).toBeNull();
      const shared = { ...scope, project: "shared-project" };
      await jobs.configure(shared, { ...DEFAULT_SEARCH_SETTINGS, enabled: false }, 0);
      expect((await jobs.get({ ...shared, owner: "other-owner" }))!.owner).toBe(scope.owner);
      await expect(
        jobs.configure({ ...shared, owner: "other-owner" }, { ...DEFAULT_SEARCH_SETTINGS, enabled: false }, 0),
      ).rejects.toMatchObject({ code: "conflict" });
      const expired = (await jobs.claim())!;
      expect(expired.key).toBe(configured.key);
      expect(await jobs.claim()).toBeNull();
      now += 120001;
      const replacement = (await jobs.claim())!;
      expect(replacement).not.toBeNull();
      expect(await jobs.heartbeat(expired)).toBe(false);
      expect(await jobs.heartbeat(replacement)).toBe(true);
      const active = {
        text: { name: "a".repeat(64), provider: "local" },
        vector: null,
        analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
        source: await sources.get("builtin"),
        sourceRevision: 1,
        settingsRevision: configured.revision,
        embedding: null,
        textFingerprint: "fixture",
      };
      expect(await jobs.complete(expired, active, "saved", 1)).toBe(false);
      expect(await jobs.complete(replacement, active, "saved", 1)).toBe(true);
      const audits = new MySQLSearchAudits(db, () => now),
        ready = (await jobs.get(scope))!,
        auditTicket = (await audits.claim(ready, 1))!;
      expect(auditTicket).not.toBeNull();
      expect(await audits.claim(ready, 1)).toBeNull();
      expect(
        await audits.finish(
          auditTicket,
          { status: "healthy", action: "none", checks: ["fixture-metadata"], count: 1 },
          () => {
            throw Error("Healthy audit cannot rebuild");
          },
        ),
      ).toBe(true);
      expect((await audits.view(ready, 1)).latest!.status).toBe("healthy");
      await audits.request(ready, 1);
      const staleAudit = (await audits.claim(ready, 1))!;
      await jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 1);
      let repairs = 0;
      await audits.finish(staleAudit, { status: "missing", action: "rebuild", checks: [], count: 0 }, () => {
        repairs++;
        return jobs.invalidate(ready.key, ready);
      });
      expect(repairs).toBe(0);
      expect((await audits.view(await jobs.get(scope), 1)).latest!.status).toBe("superseded");
      const storage = "1".repeat(64),
        name = "2".repeat(64),
        allocation = await resources.reserve(storage, name, "recipe", "marker");
      const physical = { name, identity: "9223372036854775807", marker: "marker" },
        reference = {
          name,
          provider: "milvus",
          integrity: {
            schema: 1 as const,
            format: "milvus-seal/1",
            recipe: "recipe",
            digest: "3".repeat(64),
            count: 0,
          },
        };
      expect(await resources.seal({ ...allocation, token: allocation.token! }, physical, reference)).toBe(true);
      expect((await resources.get(storage, name))!.identity).toBe(physical.identity);
      const read = await resources.pin(storage, name);
      await resources.release({ ...allocation, token: allocation.token! });
      expect(await resources.claimDrop(storage, name, null, true)).toBeNull();
      await resources.unpin(read);
      const drop = await resources.claimDrop(storage, name, null, true);
      expect(drop).not.toBeNull();
      await db.execute("INSERT INTO panda_force_search_meta(id,value) VALUES('unverified-index-references','1')");
      expect(await resources.mayDrop(drop!, null)).toBe(false);
      const scans = new MySQLSearchResourceScans(db, () => now),
        operation = randomUUID();
      await scans.request(storage, operation, "configured-profile");
      await scans.request(storage, operation, "configured-profile");
      expect(await scans.connection(storage)).toBe("configured-profile");
      const ticket = await scans.claim(storage, false);
      expect(ticket).not.toBeNull();
      expect(
        await scans.finish(ticket!, { physical: null, allocations: null }, [
          { name, status: "protected", missing: false },
        ]),
      ).toBe(true);
      expect((await scans.view(storage, false)).summary.protected).toBe(1);
      const nativeRoot = join(root, "native-feature"),
        storageBackend = await createMySQLSearchPersistence(fixture.sql, {
          stateRoot: nativeRoot,
          connections: [],
          knowledge: [],
        }),
        feature = await createSearchFeature({
          stateRoot: nativeRoot,
          storage: storageBackend,
          appRoot: process.cwd(),
          env: {},
          content: {
            authorize: async () => {},
            head: async () => "empty",
            snapshot: async () => ({ commit: "empty", documents: [] }),
            current: async () => [],
          },
          owner: () => scope.owner,
          administrator: () => true,
          report: () => {},
        });
      try {
        expect((await feature.api.catalog({} as never)).binding.source).toBe("builtin");
        expect(await Bun.file(join(nativeRoot, "data", "search.sqlite")).exists()).toBe(false);
      } finally {
        await feature.close();
      }
      expect(await registry.inspect(schema)).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
