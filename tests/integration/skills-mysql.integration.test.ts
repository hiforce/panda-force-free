import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlSkillsModule } from "../../src/server/database/modules/skills.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { SkillCatalog } from "../../src/server/skills/catalog/service.js";
import { SqliteSkillRegistry } from "../../src/server/skills/storage/repository.js";
import { MySQLSkillRegistry } from "../../src/server/skills/storage/mysql.js";
import { openSkillDatabase } from "../../src/server/skills/storage/database.js";
import { FileSkillBundles } from "../../src/server/skills/storage/bundles.js";
import { migrateSkillsSnapshot } from "../../src/server/skills/storage/migrate.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { SKILL_CAPABILITIES } from "../../src/shared/skills/contracts.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
async function pack(version?: string) {
  const root = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url),
    manifest = JSON.parse(readFileSync(new URL("panda-skills.json", root), "utf8"));
  if (version) manifest.version = version;
  return verifySkillResources(
    new TextEncoder().encode(JSON.stringify(manifest)),
    manifest.files.map((p: string) => ({ path: p, bytes: new Uint8Array(readFileSync(new URL(p, root))) })),
  );
}
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "skill installations, immutable versions, audit and owner-bound captures survive MySQL migration and concurrent changes",
  async () => {
    const f = await isolatedMySQLDatabase("registry"),
      root = await mkdtemp(join(tmpdir(), "skill-registry-mysql-")),
      sourcePath = join(root, "source.sqlite"),
      source = openSkillDatabase(sourcePath),
      bundles = new FileSkillBundles(join(root, "bundles")),
      registry = new SqliteSkillRegistry(source),
      legacy = new SkillCatalog(registry, bundles, "0.0.21"),
      value = await pack(),
      origin = { kind: "upload", name: "writing-kit.zip", sha256: value.digest };
    try {
      const review = await legacy.review(value, origin, ["writing"]),
        approval = {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
        installed = await legacy.install(value, origin, approval, "reviewer"),
        capture = await legacy.capture(
          {
            id: randomUUID(),
            requestBinding: "a".repeat(64),
            selections: [
              {
                packageId: installed.id,
                version: installed.version,
                digest: installed.digest,
                id: "writing",
                parameters: {},
              },
            ],
          },
          "owner",
          {
            outputType: "document",
            available: new Set(SKILL_CAPABILITIES),
            granted: new Set(SKILL_CAPABILITIES),
            entitled: new Set<string>(),
          },
        );
      const snapshotPath = join(root, "snapshot.sqlite"),
        reader = new Database(sourcePath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(snapshotPath);
      } finally {
        reader.close();
      }
      const schemas = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlSkillsModule);
      await schemas.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateSkillsSnapshot({ sql: f.sql, snapshotPath, migrationId: "skills-v1" });
      const native = new MySQLSkillRegistry(f.sql),
        catalog = new SkillCatalog(native, bundles, "0.0.21"),
        other = new SkillCatalog(new MySQLSkillRegistry(f.sql), bundles, "0.0.21");
      expect(await catalog.list()).toEqual(await legacy.list());
      expect(await catalog.list(undefined, 1, true)).toEqual(await legacy.list(undefined, 1, true));
      expect(await catalog.audit()).toEqual(await legacy.audit());
      expect(await catalog.detail(installed.id, installed.version)).toEqual(
        await legacy.detail(installed.id, installed.version),
      );
      expect(await catalog.getCapture(capture.id, "owner")).toEqual(capture);
      await expect(catalog.getCapture(capture.id, "other-owner")).rejects.toThrow("notFound");
      expect(await catalog.install(value, origin, approval, "reviewer")).toEqual(installed);
      const command = { id: installed.id, version: installed.version, expectedRevision: await native.revision() };
      const results = await Promise.allSettled([
        catalog.setExports(
          { ...command, operationId: randomUUID(), exports: installed.exports.map((e) => ({ ...e, enabled: false })) },
          "reviewer",
        ),
        other.remove({ ...command, operationId: randomUUID() }, "reviewer"),
      ]);
      expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((v) => v.status === "rejected")).toHaveLength(1);
      expect(await native.revision()).toBe(2);
      expect((await catalog.list(undefined, 100, true)).packages).toEqual([]);
      expect((await catalog.list()).packages).toHaveLength(1);
      expect(await catalog.getCapture(capture.id, "owner")).toEqual(capture);
      expect((await catalog.audit()).map((v) => v.revision)).toEqual([1, 2]);
      const changed = await pack();
      expect((await catalog.export(changed.manifest.id, changed.manifest.version)).digest).toBe(value.digest);
      await expect(catalog.list("invalid-cursor")).rejects.toThrow("invalidInput");
      for (const version of ["1.0.1", "1.0.2"]) {
        const upgrade = await pack(version),
          source = { ...origin, sha256: upgrade.digest },
          review = await catalog.review(upgrade, source, ["blog-outline"]);
        await catalog.install(
          upgrade,
          source,
          {
            id: randomUUID(),
            expectedRevision: review.revision,
            reviewHash: review.reviewHash,
            selected: review.selected,
            capabilities: review.capabilities,
          },
          "reviewer",
        );
      }
      const current = await catalog.list(undefined, 1, true);
      expect(current.packages.map((p) => p.version)).toEqual(["1.0.2"]);
      expect(current.nextCursor).toBeNull();
      expect((await catalog.list(undefined, 100)).packages).toHaveLength(3);
      expect(await schemas.inspect(new MySQLSchemaConnection(f.sql))).toEqual([]);
    } finally {
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
