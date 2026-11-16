import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { openSkillDatabase } from "../../src/server/skills/storage/database.js";
import { SqliteSkillRegistry } from "../../src/server/skills/storage/repository.js";
import { FileSkillBundles } from "../../src/server/skills/storage/bundles.js";
import { SkillCatalog } from "../../src/server/skills/catalog/service.js";
import type { SkillPackManifest } from "../../src/shared/skills/contracts.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { createTemplateCatalogFeature } from "../../src/server/templates/integration/feature.js";
import { skillTemplateSource } from "../../src/server/templates/integration/skill-source.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { inspectDependencies } from "../../scripts/quality/dependencies.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { managedTemplateKey, type ManagedTemplate } from "../../src/shared/templates/catalog.js";

test("Post discovery includes thread-only layouts and keeps Article layouts separate", async () => {
  const { catalog } = createTemplateCatalogFeature({
    presentation: () => ({ revision: 0, packages: [] }),
    skills: () => ({ revision: 0, packages: [], nextCursor: null }),
    owner: () => "owner",
  });
  const original = (await catalog.list()).templates.find((item) => item.templateType === "panda.channel-format")!;
  const templates = (
    [
      ["thread-only", "x-thread"],
      ["article-only", "x-article"],
    ] as const
  ).map(([id, format]): ManagedTemplate => {
    const reference = { registry: "builtin", kind: "channel-template", id, version: "1", digest: "fixture" } as const;
    return {
      ...structuredClone(original),
      reference,
      key: managedTemplateKey(reference),
      compatibility: { ...original.compatibility, formats: [format] },
    };
  });
  const scoped = new TemplateCatalog([
    {
      registry: "builtin",
      async read() {
        return { registry: "builtin", revision: "1", templates };
      },
    },
  ]);
  expect((await scoped.list({ section: "channel", format: "x-post" })).templates.map((item) => item.key)).toEqual([
    templates[0]!.key,
  ]);
  expect((await scoped.list({ section: "channel", format: "x-article" })).templates.map((item) => item.key)).toEqual([
    templates[1]!.key,
  ]);
});

test("the federated directory reflects native template state, separates classifications and returns no package content or invented actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-template-directory-"));
  const pluginDb = openPluginDatabase(":memory:"),
    skillDb = openSkillDatabase(":memory:");
  try {
    const plugins = new PluginRegistryService(
      new SqlitePluginRegistry(pluginDb),
      new FilePluginBundles(join(root, "themes")),
    );
    const skills = new SkillCatalog(
      new SqliteSkillRegistry(skillDb),
      new FileSkillBundles(join(root, "skills")),
      "0.0.16",
    );
    const { catalog } = createTemplateCatalogFeature({
      presentation: () => plugins.snapshot(),
      skills: (cursor, limit) => skills.list(cursor, limit),
      owner: () => "owner",
    });
    const initial = await catalog.list({ limit: 2 });
    expect(initial.templates).toHaveLength(2);
    expect(initial.total).toBe(7);
    const next = await catalog.list({ limit: 2, cursor: initial.nextCursor! });
    expect(next.templates.every((item) => !initial.templates.some((prior) => prior.key === item.key))).toBe(true);
    await expect(catalog.list({ category: "writing", limit: 2, cursor: initial.nextCursor! })).rejects.toThrow(
      "catalogChanged",
    );
    const sites = await catalog.list({ section: "site", engine: "hexo", limit: 1 });
    expect(sites.total).toBeGreaterThan(1);
    expect(sites.templates).toHaveLength(1);
    expect(
      sites.templates.every(
        (item) => item.templateType === "panda.site-theme" && item.compatibility.engines.includes("hexo"),
      ),
    ).toBe(true);
    const siteNext = await catalog.list({ section: "site", engine: "hexo", limit: 1, cursor: sites.nextCursor! });
    expect(siteNext.templates[0]!.key).not.toBe(sites.templates[0]!.key);
    await expect(
      catalog.list({ section: "site", engine: "docusaurus", limit: 1, cursor: sites.nextCursor! }),
    ).rejects.toThrow("catalogChanged");
    const channelArticles = await catalog.list({ section: "channel", format: "x-article", limit: 1 });
    expect(channelArticles.total).toBeGreaterThan(0);
    expect(channelArticles.templates.every((item) => item.compatibility.formats.includes("x-article"))).toBe(true);
    const value = exampleThemePackage(),
      selected = [{ kind: "channel-template" as const, id: "paper" }];
    const review = await plugins.review(value, selected);
    await plugins.install(
      value,
      {
        digest: review.digest,
        permissions: review.permissions,
        selected: review.selected,
        reviewHash: review.reviewHash,
        expectedRevision: review.revision,
      },
      "owner",
    );
    await expect(catalog.list({ limit: 2, cursor: initial.nextCursor! })).rejects.toThrow("catalogChanged");
    const source = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("panda-skills.json", source), "utf8")) as SkillPackManifest;
    const definition = manifest.skills.find((skill) => skill.id === "blog-outline")!;
    definition.category = "slides";
    const pack = await verifySkillResources(
      new TextEncoder().encode(JSON.stringify(manifest)),
      await Promise.all(
        manifest.files.map(async (path) => ({ path, bytes: new Uint8Array(await readFile(new URL(path, source))) })),
      ),
    );
    const origin = { kind: "upload", name: "Writing Kit.zip", sha256: pack.digest };
    const approval = await skills.review(pack, origin, ["blog-outline"]);
    await skills.install(
      pack,
      origin,
      {
        id: randomUUID(),
        selected: approval.selected,
        capabilities: approval.capabilities,
        reviewHash: approval.reviewHash,
        expectedRevision: approval.revision,
      },
      "owner",
    );
    const articles = await catalog.list({ type: "panda.document-template" });
    expect(articles.templates).toHaveLength(1);
    expect(articles.templates[0]).toMatchObject({
      categories: ["slides"],
      compatibility: { outputs: ["document"] },
      state: { enabled: true },
      actions: { editor: null, preview: "skill-template", export: "skill-package" },
    });
    const all = await catalog.list();
    const creation = await catalog.list({ domain: "skills", limit: 1 });
    expect(creation.total).toBe(3);
    expect(creation.templates.every((item) => item.reference.registry === "skills")).toBe(true);
    await expect(catalog.list({ domain: "publishing", limit: 1, cursor: creation.nextCursor! })).rejects.toThrow(
      "catalogChanged",
    );
    expect((await catalog.list({ domain: "skills", section: "site" })).total).toBe(0);
    expect((await catalog.list({ domain: "skills", type: "panda.channel-format" })).total).toBe(0);
    expect((await catalog.list({ domain: "publishing" })).total).toBe(all.total - creation.total);
    await expect(catalog.list({ domain: "invalid" as "skills" })).rejects.toThrow("invalidQuery");
    const skillPage = await catalog.list({ registry: "skills", limit: 1 });
    expect(skillPage.total).toBe(3);
    expect(skillPage.templates.every((item) => item.reference.registry === "skills")).toBe(true);
    const skillNext = await catalog.list({ registry: "skills", limit: 1, cursor: skillPage.nextCursor! });
    expect(skillNext.templates[0]!.key).not.toBe(skillPage.templates[0]!.key);
    await expect(catalog.list({ registry: "builtin", limit: 1, cursor: skillPage.nextCursor! })).rejects.toThrow(
      "catalogChanged",
    );
    expect(all.templates.filter((item) => item.reference.registry === "skills")).toHaveLength(3);
    expect(
      all.templates.some(
        (item) =>
          item.reference.registry === "skills" &&
          item.reference.exportId === "writing" &&
          item.templateType === "panda.creation-workflow",
      ),
    ).toBe(true);
    expect(JSON.stringify(all)).not.toContain("instructions.md");
    expect(JSON.stringify(all)).not.toContain("studioMarker");
    expect(all.templates.filter((item) => item.reference.registry === "presentation")).toHaveLength(1);
    plugins.setExportEnabled(value.manifest.id, value.manifest.version, selected[0]!, false, 1, "owner");
    const disabled = await catalog.list({ state: "disabled" });
    expect(
      disabled.templates.some(
        (item) => item.reference.registry === "presentation" && item.state.exportEnabled === false,
      ),
    ).toBe(true);
    const unchanged = await catalog.list({ type: "panda.document-template" });
    unchanged.templates[0]!.label.name = "Mutated in a consumer";
    expect((await catalog.list({ type: "panda.document-template" })).templates[0]!.label.name).toBe("Blog outline");
    expect(plugins.audit()).toHaveLength(2);
    expect(await skills.audit()).toHaveLength(1);
  } finally {
    pluginDb.close();
    skillDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native skill pagination cannot silently mix registry revisions or repeat a cursor", async () => {
  let reads = 0;
  await expect(
    skillTemplateSource(() => ({ revision: ++reads, packages: [], nextCursor: reads === 1 ? "more" : null })).read(),
  ).rejects.toThrow("catalogChanged");
  await expect(skillTemplateSource(() => ({ revision: 1, packages: [], nextCursor: "repeat" })).read()).rejects.toThrow(
    "unavailable",
  );
});

test("template core cannot import concrete native registry storage through a type dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-template-boundary-"));
  try {
    await mkdir(join(root, "server/templates"), { recursive: true });
    await mkdir(join(root, "server/plugins/storage"), { recursive: true });
    await writeFile(
      join(root, "server/templates/catalog.ts"),
      "import type { Registry } from '../plugins/storage/repository.js';export type Use=Registry;",
    );
    await writeFile(
      join(root, "server/plugins/storage/repository.ts"),
      "export interface Registry { revision:number }",
    );
    const result = inspectDependencies(root);
    expect(result.missing).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.reason).toContain("Template management");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable services and storage cannot acquire each other's implementation or HTTP composition", async () => {
  const cases = [
    ["portable/service.ts", "storage/registry.ts", "../storage/registry.js"],
    ["portable/service.ts", "integration/routes.ts", "../integration/routes.js"],
    ["storage/registry.ts", "portable/installation.ts", "../portable/installation.js"],
  ];
  for (const [from, to, specifier] of cases) {
    const root = await mkdtemp(join(tmpdir(), "panda-template-port-"));
    try {
      const source = join(root, "server/templates", from!),
        target = join(root, "server/templates", to!);
      await mkdir(join(source, ".."), { recursive: true });
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(source, `import type { Value } from '${specifier}';export type Use=Value;`);
      await writeFile(target, "export interface Value { revision:number }");
      const result = inspectDependencies(root);
      expect(result.missing).toEqual([]);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.reason).toContain("Template");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
