import { MySQLVariantRepository } from "../../src/server/publishing/mysql-variant-repository.js";
import { VariantService } from "../../src/server/publishing/variant-service.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { randomUUID, createHash } from "node:crypto";
import { sourceStageRequest } from "../../src/shared/packages/stages/input.js";
import { sourceLimits } from "../../src/shared/packages/sources/contracts.js";
import { MySQLSourceStages } from "../../src/server/packages/staging/mysql.js";
import { verifyMySQLExtensionParity } from "../support/mysql-extensions-parity.js";
import { test, expect } from "bun:test";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { mysqlPluginsModule } from "../../src/server/database/modules/plugins.js";
import { mysqlTemplatesModule } from "../../src/server/database/modules/templates.js";
import { mysqlPackageSourcesModule } from "../../src/server/database/modules/package-sources.js";
import { mysqlBuildsModule } from "../../src/server/database/modules/builds.js";
import { mysqlPublishingModule } from "../../src/server/database/modules/publishing.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "extension MySQL schemas and frozen imports preserve grants, drafts, leases, versions, builds and publication reviews",
  async () => {
    const fixture = await isolatedMySQLDatabase("extension");
    try {
      const registry = new DatabaseRegistry();
      for (const module of [
        mysqlDataMigrationModule,
        mysqlPluginsModule,
        mysqlTemplatesModule,
        mysqlPackageSourcesModule,
        mysqlBuildsModule,
        mysqlPublishingModule,
      ])
        registry.register(module);
      const connection = new MySQLSchemaConnection(fixture.sql);
      expect(await registry.upgrade(connection)).toEqual([]);
      expect(await registry.upgrade(connection)).toEqual([]);
      await verifyMySQLExtensionParity(fixture.sql);
    } finally {
      await fixture.close();
    }
  },
  360000,
);

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "source stages serialize replay and competing leases on independent native stores",
  async () => {
    const fixture = await isolatedMySQLDatabase("stagecas");
    try {
      for (const step of mysqlPackageSourcesModule.migrations.mysql![0]!.steps)
        if (step.id.startsWith("panda_force_package_source_") || step.id === "panda_force_package_stages_guard")
          await fixture.sql.unsafe(step.sql);
      const first = new MySQLSourceStages(fixture.sql),
        second = new MySQLSourceStages(fixture.sql),
        request = sourceStageRequest({
          source: { kind: "github", repository: "https://github.com/example/repository", ref: "main", root: "" },
          selected: ["README.md"],
        }),
        creation = {
          actor: "owner",
          id: randomUUID(),
          operationId: randomUUID(),
          purpose: "templates" as const,
          request,
          limits: sourceLimits(),
          fingerprint: createHash("sha256")
            .update(JSON.stringify({ purpose: "templates", request }))
            .digest("hex"),
          reservedBytes: 100,
          now: 1,
        };
      let prepared = 0;
      const admissions = await Promise.all([
        first.create(creation, () => {
          prepared++;
        }),
        second.create(creation, () => {
          prepared++;
        }),
      ]);
      expect(admissions[0]).toEqual(admissions[1]);
      expect(prepared).toBe(1);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).claim("owner", creation.id, 1, 2, 100)),
      );
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected") expect(result.reason.message).toBe("stageConflict");
      expect((await first.events("owner", creation.id)).map((event) => event.revision)).toEqual([1, 2]);
    } finally {
      await fixture.close();
    }
  },
  60000,
);

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "publication review retries preserve accepted content and append audit receipts",
  async () => {
    const fixture = await isolatedMySQLDatabase("reviewcas");
    try {
      for (const migration of mysqlPublishingModule.migrations.mysql!)
        for (const step of migration.steps) await fixture.sql.unsafe(step.sql);
      const repository = new MySQLVariantRepository(fixture.sql),
        sources = {
          authorize: () => () => {},
          current: () => ({ revisionId: "revision" }),
          revision: () => ({
            documentId: "doc",
            revisionId: "revision",
            title: "Article",
            locale: "en",
            engine: "markdown" as const,
            content: "Accepted content.",
          }),
        },
        service = new VariantService(repository, sources, builtinFormats()),
        prepared = await service.prepare({
          documentId: "doc",
          revisionId: "revision",
          mode: "format",
          format: "html",
          templateId: "technical",
        }),
        reviewed = await service.review(
          prepared.variant.id,
          {
            digest: prepared.digest,
            acceptedIssues: prepared.variant.issues.map((issue) => `${issue.blockId}:${issue.code}`),
          },
          "owner",
        );
      expect(await repository.review(prepared.variant.id, reviewed.review!)).toEqual(reviewed.review!);
      expect((await service.detail(prepared.variant.id)).variant).toEqual(prepared.variant);
      expect(
        Number(
          (
            await fixture.sql`SELECT COUNT(*) n FROM panda_force_publication_reviews WHERE variantId=${prepared.variant.id}`
          )[0].n,
        ),
      ).toBe(2);
    } finally {
      await fixture.close();
    }
  },
  60000,
);
