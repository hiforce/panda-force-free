import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { mysqlSearchEmbeddingsModule } from "../../src/server/database/modules/search-embeddings.js";
import { MySQLMetadataContext } from "../../src/server/knowledge/storage/mysql-context.js";
import { MySQLEmbeddingBudget } from "../../src/server/search/storage/mysql-embedding-budget.js";
import { openEmbeddingDatabase } from "../../src/server/search/embeddings/database.js";
import { EmbeddingBudget } from "../../src/server/search/embeddings/budget.js";
import { SearchEmbeddingService } from "../../src/server/search/embeddings/service.js";
import { embeddingPolicy } from "../../src/server/search/embeddings/policy.js";
import { migrateEmbeddingSnapshot } from "../../src/server/search/embeddings/mysql-migration.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "embedding usage, uncertain provider charges and leases migrate while binary cache ownership stays local",
  async () => {
    const fixture = await isolatedMySQLDatabase("embed"),
      root = await mkdtemp(join(tmpdir(), "embedding-mysql-")),
      path = join(root, "source.sqlite"),
      policy = embeddingPolicy({
        callsPerDay: 10,
        ownerCallsPerDay: 2,
        charactersPerDay: 100,
        ownerCharactersPerDay: 50,
      });
    let now = 1000000;
    try {
      const source = openEmbeddingDatabase(path),
        old = new EmbeddingBudget(source, policy, () => now),
        a = old.admit("model", "alice", 20),
        b = old.admit("model", "alice", 20);
      old.complete(b, "model", true, false);
      old.complete(a, "model", false, false);
      source.close();
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlSearchEmbeddingsModule),
        schema = new MySQLSchemaConnection(fixture.sql);
      await registry.upgrade(schema);
      await migrateEmbeddingSnapshot({ sql: fixture.sql, snapshotPath: path, migrationId: "embedding-v1" });
      const context = new MySQLMetadataContext(fixture.sql, "search-embeddings"),
        budget = new MySQLEmbeddingBudget(context, policy, () => now),
        other = new MySQLEmbeddingBudget(new MySQLMetadataContext(fixture.sql, "search-embeddings"), policy, () => now);
      expect((await budget.usage("alice")).calls).toBe(2);
      await expect(budget.admit("model", "bob", 1)).rejects.toMatchObject({ code: "limit" });
      now += 5001;
      await expect(budget.admit("model", "alice", 1)).rejects.toMatchObject({ code: "limit" });
      const bob = await budget.admit("model", "bob", 40);
      await budget.complete(bob, "model", false, false);
      const day = await context.one<{ calls: number; characters: number }>(
        "SELECT calls,characters FROM panda_force_embedding_usage WHERE bucket='day'",
      );
      expect(day).toEqual({ calls: 3, characters: 80 });
      const first = randomUUID(),
        second = randomUUID();
      expect(await budget.lock("namespace", first)).toBe(true);
      expect(await other.lock("namespace", second)).toBe(false);
      now += 60001;
      expect(await budget.heartbeat("namespace", first)).toBe(false);
      expect(await other.lock("namespace", second)).toBe(true);
      await budget.unlock("namespace", first);
      expect(await other.heartbeat("namespace", second)).toBe(true);
      let calls = 0;
      const localPath = join(root, "cache.sqlite"),
        manager = new SearchEmbeddingService(
          localPath,
          join(root, "cache"),
          "same-instance",
          policy,
          () => {},
          () => now,
          (p, time) => new MySQLEmbeddingBudget(new MySQLMetadataContext(fixture.sql, "search-embeddings"), p, time),
        ),
        raw = {
          dimensions: 2,
          fingerprint: () => "synthetic-model",
          health: async () => true,
          embed: async (texts: string[]) => {
            calls++;
            return texts.map(() => [0.25, 0.5]);
          },
        },
        provider = manager.provider(raw, "synthetic", { owner: "cache-owner", project: "personal", source: "builtin" });
      try {
        expect(await provider.embed(["cached text"], new AbortController().signal)).toEqual([[0.25, 0.5]]);
        await provider.embed(["cached text"], new AbortController().signal);
        expect(calls).toBe(1);
        expect((await manager.usageAsync("cache-owner")).calls).toBe(1);
      } finally {
        await manager.close();
      }
      const local = new Database(localPath, { readonly: true, strict: true });
      try {
        expect((local.query("SELECT COUNT(*) n FROM embedding_cache").get() as { n: number }).n).toBe(1);
        expect(
          local
            .query(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('embedding_usage','embedding_locks','embedding_inflight','embedding_backoff')",
            )
            .all(),
        ).toEqual([]);
      } finally {
        local.close();
      }
      expect(await schema.table("panda_force_embedding_cache")).toBe(false);
      expect(await registry.inspect(schema)).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
