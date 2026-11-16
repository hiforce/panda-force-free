import { test, expect } from "bun:test";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { createMySQLExtensionStores } from "../../src/server/database/extension-stores.js";
import { mysqlPublishingModule } from "../../src/server/database/modules/publishing.js";
import { mysqlBuildsModule } from "../../src/server/database/modules/builds.js";
import { MySQLDocumentSession } from "../../src/server/documents/mysql-session.js";
import { VariantService } from "../../src/server/publishing/variant-service.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { SiteBuildService } from "../../src/server/builds/service.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SampleExecutor } from "../support/site-sample-fixture.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "joined document transactions fence publication and build mutations on one connection and roll back together",
  async () => {
    const database = await isolatedMySQLDatabase("joined"),
      root = await mkdtemp(join(tmpdir(), "mysql-extension-joined-"));
    let builds: SiteBuildService | undefined;
    try {
      for (const module of [mysqlPublishingModule, mysqlBuildsModule])
        for (const migration of module.migrations.mysql!)
          for (const step of migration.steps) await database.sql.unsafe(step.sql);
      await database.sql.unsafe("CREATE TABLE panda_force_document_mutex(id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB");
      await database.sql.unsafe(
        "CREATE TABLE panda_force_test_authority(id INT NOT NULL PRIMARY KEY,allowed INT NOT NULL) ENGINE=InnoDB",
      );
      await database.sql.unsafe("INSERT INTO panda_force_test_authority VALUES(1,1)");
      const session = new MySQLDocumentSession(database.sql),
        stores = createMySQLExtensionStores(database.sql, {
          documentTransaction: (work) => session.transactionConnection(work),
        }),
        guard = async () => {
          const row = await session.one<{ allowed: number }>(
            "SELECT allowed FROM panda_force_test_authority WHERE id=1",
          );
          if (!row?.allowed) throw Error("fixtureRevokedAuthorization");
        },
        publishing = new VariantService(
          stores.publishing,
          {
            authorize: () => guard,
            current: () => ({ revisionId: "revision" }),
            revision: () => ({
              documentId: "doc",
              revisionId: "revision",
              title: "Joined article",
              locale: "en",
              engine: "markdown",
              content: "Saved immutable content.",
            }),
          },
          builtinFormats(),
        );
      await expect(
        stores.publishing.transaction(async () => {
          await session.run("UPDATE panda_force_test_authority SET allowed=0 WHERE id=1");
          return publishing.prepare({
            documentId: "doc",
            revisionId: "revision",
            mode: "format",
            format: "html",
            templateId: (await publishing.templates())[0]!.id,
          });
        }),
      ).rejects.toThrow("fixtureRevokedAuthorization");
      expect((await database.sql.unsafe("SELECT allowed FROM panda_force_test_authority WHERE id=1"))[0].allowed).toBe(
        1,
      );
      expect((await database.sql.unsafe("SELECT count(*) AS n FROM panda_force_publication_variants"))[0].n).toBe(0);
      const prepared = await publishing.prepare({
        documentId: "doc",
        revisionId: "revision",
        mode: "format",
        format: "html",
        templateId: (await publishing.templates())[0]!.id,
      });
      expect((await stores.publishing.get(prepared.variant.id)).digest).toBe(prepared.digest);
      const executor = new SampleExecutor(),
        input = {
          protocol: 1 as const,
          engine: "hexo" as const,
          preset: "reader" as const,
          site: { title: "Joined build", locale: "en", url: "https://example.test", basePath: "/" },
          documents: [{ id: randomUUID(), path: "intro.md", title: "Intro", content: "Saved build content." }],
          assets: [],
        };
      builds = new SiteBuildService(
        { authorize: guard, capture: async () => ({ input, sources: [] }) },
        stores.builds,
        new SiteBuildArtifacts(join(root, "artifacts")),
        executor,
        null,
        () => {},
        undefined,
        (work) => stores.builds.transaction(work),
      );
      const request = {
        id: randomUUID(),
        spaceId: randomUUID(),
        engine: "hexo",
        title: "Joined build",
        locale: "en",
        url: "https://example.test",
        basePath: "/",
      };
      await expect(
        stores.builds.transaction(async () => {
          const job = await builds!.start(request, "owner");
          await session.run("UPDATE panda_force_test_authority SET allowed=0 WHERE id=1");
          await builds!.cancel(job.id, "owner");
        }),
      ).rejects.toThrow("fixtureRevokedAuthorization");
      expect((await database.sql.unsafe("SELECT count(*) AS n FROM panda_force_site_builds"))[0].n).toBe(0);
      expect((await database.sql.unsafe("SELECT allowed FROM panda_force_test_authority WHERE id=1"))[0].allowed).toBe(
        1,
      );
    } finally {
      await builds?.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
