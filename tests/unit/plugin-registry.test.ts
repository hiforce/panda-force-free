import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { PluginPackage } from "../../src/shared/plugins/contracts.js";
import { PACKAGE_LIMITS } from "../../src/shared/plugins/contracts.js";
import { parsePluginPackage, verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import type { PluginBundleStore } from "../../src/server/plugins/ports.js";

const roots: string[] = [],
  databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, content: string | Buffer) => ({
  path,
  data: Buffer.from(content).toString("base64"),
  sha256: digest(content),
});
function templatePackage(version = "1.0.0"): PluginPackage {
  return {
    schema: 1,
    manifest: {
      schema: 1,
      id: "example.studio",
      version,
      name: "Studio templates",
      description: "A test package.",
      permissions: ["content:templates"],
      siteThemes: [],
      channelTemplates: [
        {
          id: "paper",
          name: "Research paper",
          description: "A readable article.",
          labels: { "zh-CN": { name: "研究文章", description: "文章排版" } },
          formats: ["html", "x-article"],
          style: { font: "Georgia,serif", color: "#222222", accent: "#884422", width: "720px", size: "17px" },
        },
      ],
    },
    files: [],
  };
}
function themePackage(version = "2.0.0"): PluginPackage {
  const value = templatePackage(version);
  value.manifest.permissions.push("content:site-themes", "build:theme-code");
  value.manifest.siteThemes.push({
    id: "journal",
    name: "Journal",
    description: "A trusted executable Hexo theme.",
    engine: "hexo",
    engineVersion: "8.1.1",
    root: "themes/journal",
  });
  value.files.push(file("themes/journal/layout/layout.ejs", "<main><%- body %></main>"));
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-plugin-registry-"));
  roots.push(root);
  const path = join(root, "plugins.sqlite"),
    db = openPluginDatabase(path);
  databases.push(db);
  const registry = new SqlitePluginRegistry(db),
    bundles = new FilePluginBundles(join(root, "bundles")),
    service = new PluginRegistryService(registry, bundles, () => 1700000000000);
  return { root, path, db, registry, bundles, service };
}
async function install(service: PluginRegistryService, value: PluginPackage) {
  const review = await service.review(value);
  return service.install(
    value,
    {
      digest: review.digest,
      expectedRevision: review.revision,
      permissions: review.permissions,
    },
    "reviewer:test",
  );
}

test("exporting a disabled immutable package never enables it or changes execution authority", async () => {
  const { service } = await fixture();
  const value = themePackage();
  const installed = await install(service, value);
  service.setEnabled(installed.id, installed.version, false, service.snapshot().revision, "reviewer:test");
  const before = service.snapshot(),
    audit = service.audit();
  const exported = await service.exportPackage(installed.id, installed.version);
  expect(exported.package).toEqual((await verifyPluginPackage(value)).package);
  expect(exported.digest).toBe(installed.digest);
  expect(service.snapshot()).toEqual(before);
  expect(service.audit()).toEqual(audit);
  await expect(service.capture(installed.id, installed.version)).rejects.toThrow("packageDisabled");
  await expect(service.exportPackage("../invalid", installed.version)).rejects.toThrow();
  await expect(service.exportPackage(installed.id, "9.9.9")).rejects.toThrow("packageNotInstalled");
});

test("package identity is stable across JSON key and file order and detects actual content replacement", async () => {
  const value = themePackage();
  value.files.push(file("themes/journal/source/style.css", "body{color:#222}"));
  value.files.push(file("themes/journal/source/文章 illustration.svg", "<svg></svg>"));
  const checked = await verifyPluginPackage(value),
    copy = structuredClone(value);
  copy.files.reverse();
  copy.manifest.permissions.reverse();
  expect((await parsePluginPackage(JSON.stringify(copy))).digest).toBe(checked.digest);
  const keyOrderCopy = JSON.parse(JSON.stringify(copy));
  keyOrderCopy.manifest = Object.fromEntries(Object.entries(keyOrderCopy.manifest).reverse());
  expect((await verifyPluginPackage(keyOrderCopy)).digest).toBe(checked.digest);
  expect(checked.fileCount).toBe(3);
  expect(checked.byteLength).toBe(Buffer.from("<main><%- body %></main>body{color:#222}<svg></svg>").length);
  copy.files[0]!.data = Buffer.from("changed").toString("base64");
  await expect(verifyPluginPackage(copy)).rejects.toThrow("packageDigestMismatch");
  copy.files[0] = file(copy.files[0]!.path, "changed");
  expect((await verifyPluginPackage(copy)).digest).not.toBe(checked.digest);
});

test("manifest denies unsupported capabilities, unapproved execution, namespace spoofing and unsafe template styles", async () => {
  const value = themePackage();
  for (const mutate of [
    (v: PluginPackage) => {
      v.manifest.id = "panda.reader";
    },
    (v: PluginPackage) => {
      v.manifest.version = "01.0.0";
    },
    (v: PluginPackage) => {
      v.manifest.name = "Hidden\u0085control";
    },
    (v: PluginPackage) => {
      v.manifest.siteThemes[0]!.engineVersion = "1.0.0";
    },
    (v: PluginPackage) => {
      v.manifest.permissions = ["content:templates"];
    },
    (v: PluginPackage) => {
      (v.manifest as unknown as Record<string, unknown>).command = "npm install";
    },
    (v: PluginPackage) => {
      v.manifest.channelTemplates[0]!.style.font = "url(https://example.invalid)";
    },
    (v: PluginPackage) => {
      (v.manifest.permissions as string[]).push("credentials:read");
    },
    (v: PluginPackage) => {
      v.manifest.channelTemplates[0]!.id = "journal";
    },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    await expect(verifyPluginPackage(copy)).rejects.toThrow();
  }
  const checked = await verifyPluginPackage(templatePackage());
  expect(checked.package.manifest.permissions).toEqual(["content:templates"]);
  expect(checked.package.manifest.channelTemplates[0]!.name).toBe("Research paper");
  expect(checked.package.manifest.channelTemplates[0]!.labels?.["zh-CN"]?.name).toBe("研究文章");
});

test("package files cannot escape their declared theme roots, alias paths or carry hidden configuration", async () => {
  for (const path of [
    "themes/journal/" + "文".repeat(90) + ".js",
    "../escape.js",
    "/tmp/escape.js",
    "themes/journal/../escape.js",
    "themes\\journal\\escape.js",
    "themes/journal/.env",
    "themes/journal/.codex/config.json",
    "themes/journal/auth.json",
    "themes/journal/id_rsa",
    "themes/journal/node_modules/lib.js",
    "themes/journal/file:stream.js",
    "themes/journal/CON.js",
    "themes/journal/file.js ",
    "other/code.js",
    "themes/journal/tool.sh",
  ]) {
    const value = themePackage();
    value.files.push(file(path, "unsafe"));
    await expect(verifyPluginPackage(value)).rejects.toThrow();
  }
  for (const paths of [
    ["themes/journal/source/Style.css", "themes/journal/source/style.css"],
    ["themes/journal/Source/a.css", "themes/journal/source/b.css"],
    ["themes/journal/source/caf\u00e9.css", "themes/journal/source/cafe\u0301.css"],
    ["themes/journal/tree.js", "themes/journal/tree.js/nested.css"],
  ]) {
    const value = themePackage();
    value.files.push(...paths.map((path) => file(path, "fixture")));
    await expect(verifyPluginPackage(value)).rejects.toThrow("invalidPackagePath");
  }
});

test("Docusaurus requires a present fixed worker entry and every theme requires usable template files", async () => {
  const value = templatePackage();
  value.manifest.permissions.push("content:site-themes", "build:theme-code");
  value.manifest.siteThemes.push({
    id: "reference",
    name: "Reference",
    description: "Test theme.",
    engine: "docusaurus",
    engineVersion: "3.10.2",
    root: "themes/reference",
    entry: "index.js",
  });
  await expect(verifyPluginPackage(value)).rejects.toThrow("invalidPackage");
  value.files.push(file("themes/reference/index.js", "module.exports=()=>({name:'fixture'});"));
  expect((await verifyPluginPackage(value)).package.manifest.siteThemes[0]!.entry).toBe("index.js");
  value.manifest.siteThemes[0]!.entry = "../../outside.js";
  await expect(verifyPluginPackage(value)).rejects.toThrow("invalidPackagePath");
  const hexo = themePackage();
  hexo.files = [file("themes/journal/style.css", "body{}")];
  await expect(verifyPluginPackage(hexo)).rejects.toThrow("invalidPackage");
});

test("bounded intake rejects excessive bytes, malformed JSON and noncanonical base64 before installation", async () => {
  await expect(parsePluginPackage("{")).rejects.toThrow("invalidPackage");
  await expect(parsePluginPackage(" ".repeat(PACKAGE_LIMITS.jsonBytes + 1))).rejects.toThrow("packageTooLarge");
  for (const data of ["YQ", "YQ=", "YQ==\n", "YR==", "=bad"]) {
    const value = themePackage();
    value.files[0]!.data = data;
    await expect(verifyPluginPackage(value)).rejects.toThrow("invalidPackage");
  }
  const excessive = themePackage();
  excessive.files.push(file("themes/journal/large.txt", Buffer.alloc(PACKAGE_LIMITS.fileBytes + 1)));
  await expect(verifyPluginPackage(excessive)).rejects.toThrow("packageTooLarge");
  const total = themePackage();
  for (let i = 0; i < 9; i++)
    total.files.push(file(`themes/journal/asset-${i}.txt`, Buffer.alloc(PACKAGE_LIMITS.fileBytes)));
  await expect(verifyPluginPackage(total)).rejects.toThrow("packageTooLarge");
});

test("review freezes digest and explicit permissions; upgrades retain older approved version bytes and audit", async () => {
  const { service } = await fixture(),
    old = templatePackage();
  const initial = await service.review(old);
  expect(initial.revision).toBe(0);
  expect(initial.addedPermissions).toEqual(["content:templates"]);
  expect(service.snapshot().packages).toEqual([]);
  await expect(
    service.install(old, { digest: initial.digest, expectedRevision: 0, permissions: [] }, "reviewer:test"),
  ).rejects.toThrow("approvalRequired");
  expect(service.audit()).toEqual([]);
  const installed = await install(service, old),
    next = themePackage();
  expect(installed.active).toBe(true);
  expect(installed.installedBy).toBe("reviewer:test");
  const review = await service.review(next);
  expect(review.activeVersion).toBe("1.0.0");
  expect(review.addedPermissions.sort()).toEqual(["build:theme-code", "content:site-themes"]);
  expect(review.removedPermissions).toEqual([]);
  const tampered = structuredClone(next);
  tampered.files[0] = file(tampered.files[0]!.path, "<main>changed after review</main>");
  await expect(
    service.install(
      tampered,
      { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
      "reviewer:test",
    ),
  ).rejects.toThrow("reviewChanged");
  await install(service, next);
  expect(service.snapshot().revision).toBe(2);
  expect(service.snapshot().packages.find((item) => item.version === "1.0.0")).toMatchObject({
    enabled: true,
    active: false,
  });
  expect((await service.capture(installed.id, installed.version)).digest).toBe(installed.digest);
  const audit = service.audit();
  expect(audit.map((item) => item.action)).toEqual(["install", "install"]);
  expect(audit[1]!.permissions.sort()).toEqual(["build:theme-code", "content:site-themes", "content:templates"]);
  expect(service.audit(1, 1)).toEqual([audit[1]!]);
});

test("same-version replacement is forbidden and concurrent reviewed installers cannot overwrite registry changes", async () => {
  const { service, bundles, root } = await fixture(),
    value = templatePackage();
  const review = await service.review(value);
  const approval = { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions };
  const results = await Promise.allSettled([
    service.install(value, approval, "reviewer:a"),
    service.install(value, approval, "reviewer:b"),
  ]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect(service.audit()).toHaveLength(1);
  const same = await install(service, value);
  expect(service.audit()).toHaveLength(1);
  expect(same.digest).toBe(review.digest);
  const changed = structuredClone(value);
  changed.manifest.description = "Replacement for the same version.";
  await expect(service.review(changed)).rejects.toThrow("immutableVersion");
  expect((await bundles.read(review.digest)).digest).toBe(review.digest);
  expect(await readdir(join(root, "bundles"))).toEqual([`${review.digest}.json`]);
});

test("disable, enable and explicit version rollback preserve prior identities and survive a database reopen", async () => {
  const { path, registry, bundles, service } = await fixture();
  await install(service, templatePackage());
  const newer = await install(service, themePackage());
  await service.activate(newer.id, "1.0.0", 2, "reviewer:test");
  expect(service.snapshot().revision).toBe(3);
  expect(service.snapshot().packages.find((item) => item.active)!.version).toBe("1.0.0");
  service.setEnabled(newer.id, "1.0.0", false, 3, "reviewer:test");
  expect(service.snapshot().packages.every((item) => !item.active)).toBe(true);
  await expect(service.capture(newer.id, "1.0.0")).rejects.toThrow("packageDisabled");
  await expect(service.activate(newer.id, "1.0.0", 4, "reviewer:test")).rejects.toThrow("packageDisabled");
  service.setEnabled(newer.id, "1.0.0", true, 4, "reviewer:test");
  expect(service.snapshot().packages.every((item) => !item.active)).toBe(true);
  await service.activate(newer.id, "1.0.0", 5, "reviewer:test");
  const db2 = openPluginDatabase(path);
  databases.push(db2);
  const reopened = new PluginRegistryService(new SqlitePluginRegistry(db2), bundles);
  expect(reopened.snapshot()).toEqual(registry.snapshot());
  expect(reopened.audit().map((item) => item.action)).toEqual([
    "install",
    "install",
    "activate",
    "disable",
    "enable",
    "activate",
  ]);
  expect((await reopened.capture(newer.id, newer.version)).digest).toBe(newer.digest);
  expect(() => reopened.setEnabled(newer.id, newer.version, false, 3, "reviewer:test")).toThrow("registryConflict");
});

test("a disable during bundle IO cancels capture and an unavailable bundle cannot become the active rollback", async () => {
  const { service, registry, bundles, root } = await fixture();
  const installed = await install(service, themePackage());
  const racing: PluginBundleStore = {
    put: (value) => bundles.put(value),
    async read(hash) {
      const value = await bundles.read(hash);
      service.setEnabled(installed.id, installed.version, false, 1, "reviewer:test");
      return value;
    },
  };
  await expect(new PluginRegistryService(registry, racing).capture(installed.id, installed.version)).rejects.toThrow(
    "packageDisabled",
  );
  service.setEnabled(installed.id, installed.version, true, 2, "reviewer:test");
  await writeFile(join(root, "bundles", installed.digest + ".json"), "{}");
  await expect(service.activate(installed.id, installed.version, 3, "reviewer:test")).rejects.toThrow(
    "packageUnavailable",
  );
  expect(service.snapshot().revision).toBe(3);
  expect(service.snapshot().packages[0]!.active).toBe(false);
});

test("failed bundle persistence leaves no installed metadata and no audit granting execution", async () => {
  const { registry } = await fixture();
  const service = new PluginRegistryService(registry, {
    async put() {
      throw Error("Storage unavailable");
    },
    async read() {
      throw Error("No bundle");
    },
  });
  await expect(install(service, themePackage())).rejects.toThrow("Storage unavailable");
  expect(service.snapshot()).toEqual({ revision: 0, packages: [] });
  expect(service.audit()).toEqual([]);
});

test("bundle corruption and symlink targets fail closed without overwriting files outside plugin storage", async () => {
  const { root, bundles, service } = await fixture();
  const value = themePackage(),
    checked = await verifyPluginPackage(value);
  await bundles.put(checked);
  const target = join(root, "bundles", checked.digest + ".json"),
    canary = join(root, "outside-canary.json");
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  await writeFile(canary, "must remain unchanged");
  await rm(target);
  await symlink(canary, target);
  await expect(bundles.put(checked)).rejects.toThrow("packageUnavailable");
  await expect(bundles.read(checked.digest)).rejects.toThrow("packageUnavailable");
  expect(await readFile(canary, "utf8")).toBe("must remain unchanged");
  expect(service.snapshot().packages).toEqual([]);
  await expect(new FilePluginBundles(join(root, "linked")).read("../outside-canary")).rejects.toThrow(
    "packageUnavailable",
  );
  await symlink(root, join(root, "linked-root"));
  await expect(new FilePluginBundles(join(root, "linked-root")).put(checked)).rejects.toThrow("packageUnavailable");
  expect(await readdir(join(root, "bundles"))).toEqual([checked.digest + ".json"]);
});

test("plugin schema initialization is repeatable and refuses newer versions without touching existing rows", async () => {
  const { path, service, db } = await fixture();
  await install(service, templatePackage());
  const another = openPluginDatabase(path);
  databases.push(another);
  expect(new SqlitePluginRegistry(another).snapshot()).toEqual(service.snapshot());
  db.exec("PRAGMA user_version=999");
  expect(() => openPluginDatabase(path)).toThrow("unsupportedSchema");
  expect(service.snapshot().packages).toHaveLength(1);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
});

test("audit shows the latest default window while explicit cursors preserve complete older pages", async () => {
  const { service } = await fixture();
  const installed = await install(service, templatePackage());
  for (let index = 0; index < 105; index++)
    service.setEnabled(installed.id, installed.version, index % 2 !== 0, index + 1, "reviewer:test");
  const recent = service.audit();
  expect(recent).toHaveLength(100);
  expect(recent[0]!.sequence).toBe(7);
  expect(recent.at(-1)!.sequence).toBe(106);
  expect(service.audit(0, 3).map((item) => item.sequence)).toEqual([1, 2, 3]);
  expect(service.audit(104, 10).map((item) => item.sequence)).toEqual([105, 106]);
});
