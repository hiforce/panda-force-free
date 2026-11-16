import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { PluginPackage } from "../../src/shared/plugins/contracts.js";
import type { PluginExportRef } from "../../src/shared/plugins/exports.js";
import { pluginExports } from "../../src/shared/plugins/exports.js";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import { installedPresentation } from "../../src/server/plugins/integration/presentation.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { siteSampleInput } from "../../src/server/plugins/integration/site-sample-input.js";

const roots: string[] = [],
  databases: Database[] = [];
const owner = "template-reviewer";
const paper: PluginExportRef = { kind: "channel-template", id: "paper" };
const journal: PluginExportRef = { kind: "site-theme", id: "journal" };
const reference: PluginExportRef = { kind: "site-theme", id: "reference" };
const mixed = (version = "1.0.0") => exampleThemePackage(version) as PluginPackage;
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-template-exports-"));
  roots.push(root);
  const path = join(root, "registry.sqlite"),
    db = openPluginDatabase(path);
  databases.push(db);
  const registry = new SqlitePluginRegistry(db),
    bundles = new FilePluginBundles(join(root, "bundles"));
  const service = new PluginRegistryService(registry, bundles);
  return { db, path, registry, bundles, service, presentation: installedPresentation(service) };
}
async function install(service: PluginRegistryService, value: PluginPackage, selected?: PluginExportRef[]) {
  const review = await service.review(value, selected);
  return service.install(
    value,
    {
      digest: review.digest,
      permissions: review.permissions,
      expectedRevision: review.revision,
      selected: review.selected,
      reviewHash: review.reviewHash,
    },
    owner,
  );
}

test("selecting a channel from a mixed package preserves every byte without granting code or making unselected themes usable", async () => {
  const { service, presentation } = await fixture(),
    value = mixed();
  const review = await service.review(value, [paper]);
  expect(review.permissions).toEqual(["content:templates"]);
  const installed = await install(service, value, [paper]);
  expect(installed.exports).toEqual([{ ...paper, enabled: true, active: true }]);
  expect(installed.grants).toEqual(["content:templates"]);
  expect(installed.digest).toBe((await verifyPluginPackage(value)).digest);
  expect((await service.exportPackage(installed.id, installed.version)).package).toEqual(
    (await verifyPluginPackage(value)).package,
  );
  expect(presentation.themes.list("hexo").every((item) => item.kind === "builtin")).toBe(true);
  expect(presentation.templates.resolve("example.studio.paper").version).toBe("1.0.0");
  await expect(service.captureExport(installed.id, installed.version, journal)).rejects.toThrow("exportUnavailable");
  expect(() => service.setExportEnabled(installed.id, installed.version, journal, true, 1, owner)).toThrow(
    "exportUnavailable",
  );
  const frozen = await freezeTrustedBuildTheme(value, "journal");
  const input = siteSampleInput(frozen, { id: "fixed-sample", title: "Sample", content: "Fixed sample", locale: "en" });
  expect(() => presentation.authorizeBuild(input)).toThrow("themeNotApproved");
  expect(service.snapshot().revision).toBe(1);
  expect(service.audit()[0]?.permissions).toEqual(["content:templates"]);
});

test("adding one export requires a matching permission review and preserves disabled siblings", async () => {
  const { service, presentation } = await fixture(),
    value = mixed();
  await install(service, value, [paper]);
  service.setExportEnabled(value.manifest.id, "1.0.0", paper, false, 1, owner);
  const review = await service.review(value, [journal]);
  expect(review.addedPermissions).toEqual(["build:theme-code", "content:site-themes"]);
  await expect(
    service.install(
      value,
      {
        digest: review.digest,
        expectedRevision: review.revision,
        permissions: ["content:templates"],
        selected: [journal],
        reviewHash: review.reviewHash,
      },
      owner,
    ),
  ).rejects.toThrow("approvalRequired");
  const installed = await install(service, value, [journal]);
  expect(installed.exports.find((item) => item.id === "paper")).toMatchObject({ enabled: false, active: false });
  expect(installed.exports.find((item) => item.id === "journal")).toMatchObject({ enabled: true, active: true });
  expect(installed.exports.some((item) => item.id === "reference")).toBe(false);
  const theme = presentation.themes.resolve("example.studio.journal@1.0.0", "hexo");
  const input = siteSampleInput(await presentation.captureTheme(theme), {
    id: "sample",
    title: "Sample",
    content: "Fixed",
    locale: "en",
  });
  expect(() => presentation.authorizeBuild(input)).not.toThrow();
  service.setExportEnabled(installed.id, installed.version, journal, false, service.snapshot().revision, owner);
  expect(() => presentation.authorizeBuild(input)).toThrow("themeNotApproved");
  await install(service, value, [journal]);
  expect(service.snapshot().packages[0]?.exports.find((item) => item.id === "journal")?.enabled).toBe(false);
});

test("partial upgrades and explicit rollback affect only the selected export head, with no implicit fallback on disable", async () => {
  const { service, presentation } = await fixture();
  await install(service, mixed());
  await install(service, mixed("2.0.0"), [journal]);
  expect(presentation.templates.resolve("example.studio.paper").version).toBe("1.0.0");
  const versions = service.snapshot().packages;
  expect(
    versions.find((item) => item.version === "1.0.0")?.exports.find((item) => item.id === "reference")?.active,
  ).toBe(true);
  expect(versions.find((item) => item.version === "1.0.0")?.exports.find((item) => item.id === "journal")?.active).toBe(
    false,
  );
  await service.activateExport("example.studio", "1.0.0", journal, 2, owner);
  expect(service.snapshot().packages.find((item) => item.version === "2.0.0")?.exports[0]?.active).toBe(false);
  service.setExportEnabled("example.studio", "1.0.0", journal, false, 3, owner);
  expect(
    service
      .snapshot()
      .packages.every((pack) => pack.exports.filter((item) => item.id === "journal").every((item) => !item.active)),
  ).toBe(true);
  expect(() => presentation.themes.resolve("example.studio.journal@2.0.0", "hexo")).not.toThrow();
  expect(presentation.templates.resolve("example.studio.paper").version).toBe("1.0.0");
});

test("export revocation during bundle IO rejects capture; retained disabled versions stay exportable after restart", async () => {
  const { service, registry, bundles, path } = await fixture();
  const installed = await install(service, mixed(), [journal]);
  const racing = new PluginRegistryService(registry, {
    put: (value) => bundles.put(value),
    async read(hash) {
      const value = await bundles.read(hash);
      service.setExportEnabled(installed.id, installed.version, journal, false, 1, owner);
      return value;
    },
  });
  await expect(racing.captureExport(installed.id, installed.version, journal)).rejects.toThrow("exportUnavailable");
  const db = openPluginDatabase(path);
  databases.push(db);
  const reopened = new PluginRegistryService(new SqlitePluginRegistry(db), bundles);
  expect(reopened.snapshot()).toEqual(service.snapshot());
  expect(reopened.audit()).toEqual(service.audit());
  expect((await reopened.exportPackage(installed.id, installed.version)).digest).toBe(installed.digest);
  expect(() => reopened.setExportEnabled(installed.id, installed.version, journal, true, 0, owner)).toThrow(
    "registryConflict",
  );
  expect(reopened.audit().at(-1)).toMatchObject({
    action: "exports",
    exports: [{ ...journal, enabled: false, active: false }],
  });
});

test("closed export selection rejects kind spoofing, duplicates, unknown IDs and empty authority", async () => {
  const { service } = await fixture();
  for (const selected of [
    [],
    [paper, paper],
    [{ ...paper, kind: "site-theme" }],
    [{ ...journal, id: "missing" }],
    [{ ...reference, enabled: true }],
    null,
    "all",
  ])
    await expect(service.review(mixed(), selected)).rejects.toThrow("invalidPackage");
  expect(service.snapshot()).toEqual({ revision: 0, packages: [] });
  expect((await service.review(mixed())).selected).toHaveLength(3);
  const reviewed = await service.review(mixed(), [journal]);
  const substituted = await service.review(mixed(), [reference]);
  expect(reviewed.permissions).toEqual(substituted.permissions);
  expect(reviewed.reviewHash).not.toBe(substituted.reviewHash);
  await expect(
    service.install(
      mixed(),
      {
        digest: reviewed.digest,
        expectedRevision: reviewed.revision,
        selected: [reference],
        permissions: reviewed.permissions,
        reviewHash: reviewed.reviewHash,
      },
      owner,
    ),
  ).rejects.toThrow("reviewChanged");
  expect(service.snapshot().revision).toBe(0);
});

test("legacy version three approvals migrate without changing bundles, audit history or disabled behavior", async () => {
  const { db, path, service, bundles } = await fixture();
  const installed = await install(service, mixed());
  service.setEnabled(installed.id, installed.version, false, 1, owner);
  const raw = db.query("SELECT manifest,digest FROM plugin_versions").get();
  db.exec(
    "DROP TABLE plugin_export_heads;DROP TABLE plugin_exports;ALTER TABLE plugin_versions DROP COLUMN grants;ALTER TABLE plugin_audit DROP COLUMN exports;PRAGMA user_version=3",
  );
  const migrated = openPluginDatabase(path);
  databases.push(migrated);
  const reopened = new PluginRegistryService(new SqlitePluginRegistry(migrated), bundles),
    current = reopened.snapshot().packages[0]!;
  expect(migrated.query("SELECT manifest,digest FROM plugin_versions").get()).toEqual(raw);
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(current.exports.map(({ kind, id }) => ({ kind, id }))).toEqual(
    pluginExports(current.manifest).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
  );
  expect(current.grants).toEqual(current.manifest.permissions);
  expect(current.exports.every((entry) => !entry.active)).toBe(true);
  expect(reopened.snapshot().revision).toBe(2);
  expect(reopened.audit().map((event) => event.action)).toEqual(["install", "disable"]);
  await expect(reopened.captureExport(current.id, current.version, journal)).rejects.toThrow("packageDisabled");
});
