import { test, expect } from "bun:test";
import { mkdtemp, rm, copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { mysqlTemplatesModule } from "../../src/server/database/modules/templates.js";
import previewModels from "../../src/server/database/modules/templates-mysql-v2.json";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { modelDefinition, type MySQLModel } from "../../src/server/database/mysql-model.js";
import { inspectTable } from "../../src/server/database/schema-inspection.js";
import { TemplatePreviewRepository } from "../../src/server/template-previews/repository.js";
import { MySQLTemplatePreviews } from "../../src/server/template-previews/mysql-repository.js";
import { migrateTemplatePreviewsSnapshot } from "../../src/server/template-previews/migrate.js";
import { createTemplatePreviewFeature } from "../../src/server/template-previews/feature.js";
import { templatePreviewCacheKey } from "../../src/server/template-previews/service.js";
import { FileTemplatePreviewImages } from "../../src/server/template-previews/files.js";
import { builtinTemplateSource } from "../../src/server/templates/integration/presentation-source.js";
import {
  TEMPLATE_PREVIEW_RENDERER,
  type TemplatePreviewRaster,
  type TemplatePreviewJob,
} from "../../src/shared/template-previews/contracts.js";

async function until(read: () => Promise<TemplatePreviewJob>, phase: string) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (value.phase === phase) return value;
    if (Date.now() > end) throw Error("Preview did not settle: " + value.phase);
    await Bun.sleep(50);
  }
}
async function raster(): Promise<TemplatePreviewRaster> {
  const images = {} as TemplatePreviewRaster["images"];
  for (const view of ["home", "article", "mobile"] as const) {
    const width = view === "mobile" ? 390 : 1440,
      height = view === "mobile" ? 844 : 960;
    images[view] = {
      width,
      height,
      png: (
        await sharp({ create: { width, height, channels: 3, background: "#e5e1db" } })
          .png()
          .toBuffer()
      ).toString("base64"),
    };
  }
  return { schema: 1, renderer: TEMPLATE_PREVIEW_RENDERER, images };
}

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "preview v2 schema and frozen import retain image references and recover leased rendering through injected native jobs",
  async () => {
    const database = await isolatedMySQLDatabase("previews"),
      root = await mkdtemp(join(tmpdir(), "mysql-template-previews-"));
    let current: ReturnType<typeof createTemplatePreviewFeature> | undefined;
    try {
      // Existing template v1 parity is reused; only the additive preview schema is exercised here.
      for (const migration of [
        ...mysqlDataMigrationModule.migrations.mysql!,
        mysqlTemplatesModule.migrations.mysql![1]!,
      ])
        for (const step of migration.steps) {
          await database.sql.unsafe(step.sql);
          expect(await step.satisfied(new MySQLSchemaConnection(database.sql))).toBe(true);
        }
      const connection = new MySQLSchemaConnection(database.sql);
      for (const model of previewModels as readonly MySQLModel[])
        expect(await inspectTable(connection, "templates", modelDefinition(model))).toEqual([]);
      const template = (await builtinTemplateSource().read()).templates.find(
          (value) => value.reference.registry === "builtin" && value.reference.id === "panda.reader",
        )!,
        images = new FileTemplatePreviewImages(join(root, "templates", "previews", "images")),
        old = new TemplatePreviewRepository(join(root, "source.sqlite"), () => 10),
        readyId = randomUUID(),
        leasedId = randomUUID();
      const job = (id: string, locale: TemplatePreviewJob["locale"]): TemplatePreviewJob => ({
        id,
        key: templatePreviewCacheKey(template.key, locale),
        templateKey: template.key,
        locale,
        phase: "queued",
        createdAt: 1,
        updatedAt: 1,
        generation: 1,
        attempts: 0,
        failure: null,
        images: {},
      });
      old.reserve("owner", job(readyId, "en"));
      const readyClaim = old.claim()!;
      const ready = old.save(readyId, readyClaim.token, {
        phase: "ready",
        images: await images.write(readyId, await raster()),
      });
      old.reserve("owner", job(leasedId, "zh-HK"));
      const lease = old.claim()!;
      old.progress(leasedId, lease.token, "rendering");
      old.close();
      await copyFile(join(root, "source.sqlite"), join(root, "snapshot.sqlite"));
      await migrateTemplatePreviewsSnapshot({
        sql: database.sql,
        snapshotPath: join(root, "snapshot.sqlite"),
        migrationId: "preview-fixture",
      });
      expect(
        await migrateTemplatePreviewsSnapshot({
          sql: database.sql,
          snapshotPath: join(root, "snapshot.sqlite"),
          migrationId: "preview-fixture",
        }),
      ).toMatchObject({ state: "complete" });
      const jobs = new MySQLTemplatePreviews(database.sql);
      expect(await jobs.get("owner", readyId)).toEqual(ready);
      let fail = true,
        revoked = false,
        renders = 0;
      const open = () =>
        createTemplatePreviewFeature({
          stateRoot: root,
          owner: () => "owner",
          jobs: new MySQLTemplatePreviews(database.sql),
          authority: { resolve: async () => ({ ...template, state: { ...template.state, enabled: !revoked } }) },
          samples: {
            pages: async () => ({ state: "ready", home: "<h1>Public home</h1>", article: "<h1>Public article</h1>" }),
          },
          renderer: {
            render: async () => {
              renders++;
              if (fail) throw Error("fixture renderer unavailable");
              return raster();
            },
          },
        });
      current = open();
      expect(await current.service.image("owner", readyId, "home")).toEqual(await images.read(ready, "home"));
      await expect(current.service.detail("another-owner", readyId)).rejects.toThrow("notFound");
      current.start();
      const failed = await until(() => jobs.get("owner", leasedId), "failed");
      expect(failed.failure).toBe("renderUnavailable");
      await expect(jobs.save(leasedId, lease.token, { phase: "ready" })).rejects.toThrow("conflict");
      fail = false;
      expect((await current.service.retry("owner", leasedId)).generation).toBe(2);
      const completed = await until(() => jobs.get("owner", leasedId), "ready");
      expect(Object.keys(completed.images)).toHaveLength(3);
      expect((await current.service.start("owner", randomUUID(), template.key, "zh-HK")).id).toBe(leasedId);
      await current.close();
      current = open();
      expect((await current.service.lookup("owner", template.key, "zh-HK"))?.id).toBe(leasedId);
      expect((await sharp(await current.service.image("owner", leasedId, "mobile")).metadata()).width).toBe(390);
      revoked = true;
      await expect(current.service.image("owner", leasedId, "mobile")).rejects.toThrow("disabled");
      expect(renders).toBe(2);
      expect(
        (await readdir(join(root, "templates"), { recursive: true })).some((path) => path.endsWith(".sqlite")),
      ).toBe(false);
    } finally {
      await current?.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
