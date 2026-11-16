import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqliteTemplateLibrary } from "../../src/server/plugins/storage/library.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { TemplateLibraryService } from "../../src/server/plugins/library-service.js";
import { templateFixtureRunner } from "../../src/server/plugins/integration/library-fixtures.js";
import type { TemplateFixtureRunner } from "../../src/server/plugins/ports.js";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { verifyTemplateDefinition, templateFixtureCoverage } from "../../src/shared/plugins/library-validation.js";

function fixture(runner = templateFixtureRunner()) {
  const root = mkdtempSync(join(tmpdir(), "panda-library-")),
    db = openPluginDatabase(join(root, "plugins.sqlite"));
  const registry = new PluginRegistryService(
      new SqlitePluginRegistry(db),
      new FilePluginBundles(join(root, "bundles")),
    ),
    store = new SqliteTemplateLibrary(db),
    library = new TemplateLibraryService(store, runner, registry);
  return {
    root,
    db,
    registry,
    store,
    library,
    async ready() {
      let draft = await library.save(exampleTemplateDefinition(), "owner");
      const output = await library.preview(draft.id, "core");
      draft.definition.fixtures[0]!.expectedDigest = output.actualDigest;
      draft = await library.save(draft.definition, "owner", draft.id, draft.revision);
      return library.validate(draft.id, draft.revision, "owner");
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("library definitions bind origin, license, fixtures and version without changing legacy bundle identities", async () => {
  const original = await verifyTemplateDefinition(exampleTemplateDefinition()),
    changed = exampleTemplateDefinition();
  changed.archive.author = "Another author";
  const other = await verifyTemplateDefinition(changed);
  expect(original.packageDigest).toBe(other.packageDigest);
  expect(original.digest).not.toBe(other.digest);
  expect(templateFixtureCoverage(original.definition)).toEqual([]);
  const invalid = [
    { ...changed, command: "npm install" },
    { ...changed, archive: { ...changed.archive, sourceUrl: "https://user:secret@example.test" } },
    { ...changed, archive: { ...changed.archive, sourceUrl: "https://example.test/?token=private" } },
    { ...changed, fixtures: [{ ...changed.fixtures[0], format: "x-article" }] },
    { ...changed, fixtures: [changed.fixtures[0], changed.fixtures[0]] },
  ];
  for (const value of invalid) await expect(verifyTemplateDefinition(value)).rejects.toThrow();
});
test("fixed samples render real production output and require an explicit reviewed baseline", async () => {
  const f = fixture();
  try {
    let draft = await f.library.save(exampleTemplateDefinition(), "owner"),
      preview = await f.library.preview(draft.id, "core");
    expect(preview.state).toBe("unreviewed");
    expect(preview.html).toContain("<blockquote");
    expect(preview.html).toContain("const safe = true;");
    expect(preview.html).toContain("https://example.test/reference");
    expect(preview.actualDigest).toMatch(/^[a-f0-9]{64}$/);
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation!.passed).toBe(false);
    draft.definition.fixtures[0]!.expectedDigest = preview.actualDigest;
    draft = await f.library.save(draft.definition, "owner", draft.id, draft.revision);
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation!.passed).toBe(true);
    draft.definition.package.manifest.channelTemplates[0]!.style.accent = "#115599";
    draft = await f.library.save(draft.definition, "owner", draft.id, draft.revision);
    expect(draft.validation).toBe(null);
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation!.results[0]!.state).toBe("mismatch");
    const snapshot = f.library.snapshot();
    expect(snapshot.drafts[0]).not.toHaveProperty("definition");
    expect(snapshot.drafts[0]!.archive).not.toHaveProperty("licenseText");
    expect(snapshot.drafts[0]!.validation).not.toHaveProperty("results");
    expect(JSON.stringify(snapshot)).not.toContain("const safe = true;");
  } finally {
    f.close();
  }
});
test("registry installation and immutable library archive publish atomically, recover retries and preserve old releases", async () => {
  const f = fixture();
  try {
    const draft = await f.ready();
    expect(draft.validation!.passed).toBe(true);
    const review = await f.registry.review(draft.definition.package),
      approval = { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions };
    f.db.exec(
      "CREATE TRIGGER fail_archive BEFORE INSERT ON template_releases BEGIN SELECT RAISE(ABORT,'simulated archive write failure'); END",
    );
    await expect(f.library.publish(draft.id, draft.revision, draft.digest, approval, "owner")).rejects.toThrow(
      "simulated archive write failure",
    );
    expect(f.registry.snapshot().packages).toEqual([]);
    expect(f.registry.snapshot().revision).toBe(0);
    expect((await f.library.detail(draft.id)).publishedAt).toBe(null);
    f.db.exec("DROP TRIGGER fail_archive");
    const release = await f.library.publish(draft.id, draft.revision, draft.digest, approval, "owner");
    expect(release.digest).toBe(draft.digest);
    expect(f.registry.snapshot().packages).toHaveLength(1);
    expect(f.registry.snapshot().revision).toBe(1);
    expect(await f.library.publish(draft.id, draft.revision, draft.digest, approval, "owner")).toEqual(release);
    await expect(f.library.save(draft.definition, "owner", draft.id, draft.revision + 1)).rejects.toThrow(
      "libraryPublished",
    );
    const next = await f.library.fork(draft.id, "1.0.1", "owner");
    expect(next.validation).toBe(null);
    expect(next.definition.package.manifest.version).toBe("1.0.1");
    expect((await f.library.release(release.id, release.version)).definition.archive).toEqual(draft.definition.archive);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.close();
  }
});
test("coverage gaps, unapproved permissions and executable site samples never become a passing release", async () => {
  const f = fixture();
  try {
    let definition = exampleTemplateDefinition();
    definition.package.manifest.channelTemplates[0].formats.push("x-article");
    let draft = await f.library.save(definition, "owner");
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation!.missingCoverage).toEqual(["channel:paper:x-article"]);
    expect(draft.validation!.passed).toBe(false);
    await expect(
      f.library.publish(
        draft.id,
        draft.revision,
        draft.digest,
        { digest: draft.packageDigest, expectedRevision: 0, permissions: [] },
        "owner",
      ),
    ).rejects.toThrow("libraryUnverified");
    const ready = await f.ready();
    await expect(
      f.library.publish(
        ready.id,
        ready.revision,
        ready.digest,
        { digest: ready.packageDigest, expectedRevision: 0, permissions: [] },
        "owner",
      ),
    ).rejects.toThrow("approvalRequired");
    const site = {
      ...exampleTemplateDefinition(),
      package: exampleThemePackage(),
      fixtures: [
        {
          id: "site",
          name: "Site sample",
          kind: "site",
          exportId: "journal",
          engine: "hexo",
          locale: "en",
          title: "Site",
          content: "Sample",
          expectedDigest: null,
        },
      ],
    };
    draft = await f.library.save(site, "owner");
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation!.results[0]!.state).toBe("requiresBuild");
    expect(draft.validation!.passed).toBe(false);
  } finally {
    f.close();
  }
});
test("concurrent edits and validation cannot seal a mixed definition", async () => {
  const base = templateFixtureRunner();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const runner: TemplateFixtureRunner = {
    version: base.version,
    async preview(...args) {
      began();
      await hold;
      return base.preview(...args);
    },
  };
  const f = fixture(runner);
  try {
    const draft = await f.library.save(exampleTemplateDefinition(), "owner"),
      pending = f.library.validate(draft.id, draft.revision, "owner");
    await started;
    draft.definition.archive.changelog = "Changed during validation";
    const fresh = await f.library.save(draft.definition, "owner", draft.id, draft.revision);
    release();
    await expect(pending).rejects.toThrow("libraryConflict");
    expect((await f.library.detail(fresh.id)).validation).toBe(null);
    await expect(f.library.save(draft.definition, "owner", draft.id, draft.revision)).rejects.toThrow(
      "libraryConflict",
    );
  } finally {
    release();
    f.close();
  }
});

test("the reviewed baseline is digest-bound and published license archives cannot be replaced under the same version", async () => {
  const f = fixture();
  try {
    let draft = await f.library.save(exampleTemplateDefinition(), "owner"),
      preview = await f.library.preview(draft.id, "core");
    await expect(f.library.acceptBaseline(draft.id, draft.revision, "core", "0".repeat(64), "owner")).rejects.toThrow(
      "libraryUnverified",
    );
    draft = await f.library.acceptBaseline(draft.id, draft.revision, "core", preview.actualDigest!, "owner");
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    const review = await f.registry.review(draft.definition.package);
    await f.library.publish(
      draft.id,
      draft.revision,
      draft.digest,
      { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
      "owner",
    );
    const changed = structuredClone(draft.definition);
    changed.archive.license = "LicenseRef-Changed";
    let other = await f.library.save(changed, "owner");
    other = await f.library.validate(other.id, other.revision, "owner");
    const nextReview = await f.registry.review(other.definition.package);
    await expect(
      f.library.publish(
        other.id,
        other.revision,
        other.digest,
        { digest: nextReview.digest, expectedRevision: nextReview.revision, permissions: nextReview.permissions },
        "owner",
      ),
    ).rejects.toThrow("immutableVersion");
    expect((await f.library.release(draft.manifest.id, draft.manifest.version)).definition.archive.license).toBe("MIT");
  } finally {
    f.close();
  }
});

test("bounded working copies can be removed without deleting immutable version archives", async () => {
  const f = fixture();
  try {
    const first = await f.library.save(exampleTemplateDefinition(), "owner");
    for (let count = 1; count < 32; count++) await f.library.save(exampleTemplateDefinition(), "owner");
    await expect(f.library.save(exampleTemplateDefinition(), "owner")).rejects.toThrow("libraryStorageFull");
    f.library.remove(first.id, first.revision, "owner");
    expect((await f.library.save(exampleTemplateDefinition(), "owner")).revision).toBe(1);
    expect(f.registry.snapshot().packages).toEqual([]);
  } finally {
    f.close();
  }
}, 30_000);
test("schema one migration retains existing registry state and adds bounded authoring storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-library-migration-")),
    path = join(root, "legacy.sqlite");
  let db: Database | null = null;
  try {
    db = openPluginDatabase(path);
    const registry = new PluginRegistryService(
      new SqlitePluginRegistry(db),
      new FilePluginBundles(join(root, "bundles")),
    );
    const value = exampleTemplateDefinition().package,
      review = await registry.review(value);
    await registry.install(
      value,
      { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
      "migration-owner",
    );
    db.exec(
      "DROP TABLE plugin_export_heads;DROP TABLE plugin_exports;ALTER TABLE plugin_versions DROP COLUMN grants;ALTER TABLE plugin_audit DROP COLUMN exports;DROP TABLE site_sample_runs;DROP TABLE template_library_audit;DROP TABLE template_releases;DROP TABLE template_drafts;PRAGMA user_version=1",
    );
    db.close();
    db = null;
    for (let index = 0; index < 2; index++) {
      db = openPluginDatabase(path);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(db.query("SELECT * FROM plugin_registry").get()).toEqual({ id: 1, revision: 1 });
      expect(new SqlitePluginRegistry(db).get("example.editorial", "1.0.0").digest).toBe(review.digest);
      expect(new SqlitePluginRegistry(db).audit()).toHaveLength(1);
      db.close();
      db = null;
    }
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
