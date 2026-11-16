import { expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlKnowledgeModule } from "../../src/server/database/modules/knowledge.js";
import { mysqlSearchModule } from "../../src/server/database/modules/search.js";
import { mysqlBuildsModule } from "../../src/server/database/modules/builds.js";
import { createMySQLKnowledgePersistence } from "../../src/server/knowledge/storage/mysql.js";
import { MySQLMetadataContext } from "../../src/server/knowledge/storage/mysql-context.js";
import { MySQLSearchJobs } from "../../src/server/search/storage/mysql-jobs.js";
import { MySQLSearchProjectPolicies } from "../../src/server/search/storage/mysql-project-policies.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { MySQLSiteBuildRepository } from "../../src/server/builds/mysql.js";
import { MySQLProjectResourceRepository } from "../../src/server/builds/mysql-project-resource-repository.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "native batched reads preserve review/owner ordering, multi-page readiness and resource recovery bounds",
  async () => {
    const f = await isolatedMySQLDatabase("archbatch");
    const getPolicy = spyOn(MySQLSearchProjectPolicies.prototype, "get");
    try {
      const schema = new MySQLSchemaConnection(f.sql);
      await new DatabaseRegistry()
        .register(mysqlKnowledgeModule)
        .register(mysqlSearchModule)
        .register(mysqlBuildsModule)
        .upgrade(schema);
      const knowledge = await createMySQLKnowledgePersistence(f.sql),
        task = await knowledge.ledger.create(
          {
            owner: "alice",
            project: "project",
            title: "Batch",
            signature: "batch-review",
            operationId: randomUUID(),
            requestHash: "a".repeat(64),
            inputDigest: "b".repeat(64),
            dialogueDigest: "c".repeat(64),
          },
          1,
        );
      for (const [id, revision, policy] of [
        ["old-policy", 1, 9],
        ["new-draft", 2, 1],
        ["new-policy", 2, 2],
      ] as const)
        await f.sql.unsafe(
          `INSERT INTO panda_force_knowledge_reviews(id,owner,project,taskId,taskRevision,policyRevision,
          inputDigest,dialogueDigest,draftDigest,state,token,leaseUntil,createdAt)
          VALUES(?,'alice','project',?,?,?,'input','dialogue','draft','passed','token',100,1)`,
          [id, task.id, revision, policy],
        );
      expect((await knowledge.reviews.latestFor("alice", [task.id, task.id])).map((row) => row.id)).toEqual([
        "new-policy",
      ]);
      expect(await knowledge.reviews.latestFor("other-owner", [task.id])).toEqual([]);
      expect(await knowledge.reviews.latestFor("alice", [])).toEqual([]);
      await expect(
        knowledge.reviews.latestFor(
          "alice",
          Array.from({ length: 51 }, (_, i) => `missing-${i}`),
        ),
      ).rejects.toMatchObject({ code: "invalidInput" });

      const db = new MySQLMetadataContext(f.sql, "search"),
        jobs = new MySQLSearchJobs(db),
        source = {
          id: "builtin",
          name: "Built-in search",
          kind: "local",
          connection: null,
          knowledge: null,
          enabled: true,
          revision: 1,
        },
        active = {
          text: { provider: "local", name: "a".repeat(64) },
          vector: null,
          source,
          sourceRevision: 1,
          settingsRevision: 1,
          analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
          embedding: null,
          textFingerprint: "fixture",
        };
      for (let i = 0; i < 70; i++) {
        const row = await jobs.configure(
          { source: "builtin", project: `project-${i}`, owner: "alice" },
          { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
          0,
        );
        await db.execute("UPDATE panda_force_search_scopes SET state='ready',active=? WHERE `key`=?", [
          JSON.stringify({ ...active, invalidated: true }),
          row.key,
        ]);
      }
      const last = (await db.one<{ key: string }>(
        "SELECT `key` FROM panda_force_search_scopes ORDER BY `key` DESC LIMIT 1",
      ))!.key;
      getPolicy.mockClear();
      expect(await jobs.hasReadyIndex("builtin", 1)).toBeFalse();
      await db.execute("UPDATE panda_force_search_scopes SET active=? WHERE `key`=?", [JSON.stringify(active), last]);
      expect(await jobs.hasReadyIndex("builtin", 1)).toBeTrue();
      expect(await jobs.hasReadyIndex("other-source", 1)).toBeFalse();
      expect(await jobs.hasReadyIndex("builtin", 2)).toBeFalse();
      expect(getPolicy).not.toHaveBeenCalled();
      await db.execute("UPDATE panda_force_search_project_policies SET needsReview=1 WHERE `key`=?", [last]);
      expect(await jobs.hasReadyIndex("builtin", 1)).toBeFalse();
      await db.execute("UPDATE panda_force_search_project_policies SET needsReview=0,owner='bob' WHERE `key`=?", [
        last,
      ]);
      expect(await jobs.hasReadyIndex("builtin", 1)).toBeFalse();
      expect(await jobs.referencesUncertain()).toBeTrue();
      await db.execute("UPDATE panda_force_search_project_policies SET owner='alice' WHERE `key`=?", [last]);
      await db.execute("UPDATE panda_force_search_scopes SET active=? WHERE `key`=?", ["{damaged", last]);
      expect(await jobs.hasReadyIndex("builtin", 1)).toBeFalse();
      expect(
        (await db.one<{ state: string }>("SELECT state FROM panda_force_search_scopes WHERE `key`=?", [last]))?.state,
      ).toBe("queued");

      const builds = new MySQLSiteBuildRepository(f.sql),
        ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = randomUUID();
        ids.push(id);
        await builds.create(
          {
            id,
            spaceId: "space",
            engine: "hexo",
            title: "Recovery",
            locale: "en",
            url: "https://example.test",
            basePath: "/",
          },
          {
            protocol: 1,
            engine: "hexo",
            preset: "reader",
            site: { title: "Recovery", locale: "en", url: "https://example.test", basePath: "/" },
            documents: [],
            assets: [],
          },
          [],
        );
        await f.sql.unsafe(
          "INSERT INTO panda_force_site_build_resource_inputs(id,owner,reservedBytes) VALUES(?,'alice',100)",
          [id],
        );
        if (i < 17) await builds.update(id, { phase: "cancelled" });
      }
      const unavailable = (): never => {
          throw Error("Unexpected per-record query");
        },
        resources = new MySQLProjectResourceRepository(f.sql, {
          existing: unavailable,
          stored: unavailable,
          update: unavailable,
          insert: unavailable,
        });
      const pending = await resources.pending();
      expect(pending.map((row) => row.job.id)).toEqual(ids.slice(17));
      expect(pending[0]).toEqual({ job: await builds.get(ids[17]!), ready: false, reservedBytes: 100 });
      expect((await resources.cleanup()).map((row) => row.id)).toEqual(ids.slice(0, 16));
      await builds.resources.released(ids[0]!);
      expect((await resources.cleanup()).map((row) => row.id)).toEqual(ids.slice(1, 17));
    } finally {
      getPolicy.mockRestore();
      await f.close();
    }
  },
  180000,
);
