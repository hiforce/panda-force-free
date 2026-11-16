import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { inspectSourceConfiguration } from "../../src/server/documents/source-profile/inspection.js";
import { sourceYaml } from "../../src/server/documents/source-profile/yaml.js";
import { sourceImagePolicy } from "../../src/server/documents/source-profile/image-policy.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { documentThemePackager } from "../../src/server/plugins/integration/source-theme.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { verifyBuildProject, buildProject } from "../../src/shared/builds/project.js";
import { buildInput } from "../../src/shared/builds/validation.js";
import { requiresSiteProjectProtocol } from "../../src/shared/builds/capabilities.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { publicDocumentMetadata } from "../../src/shared/sites/metadata.js";
import { metadataFieldNames } from "../../src/shared/sites/profile.js";
import { hexoDocument } from "../../src/document-worker/engines/hexo-document.js";
import { verifyThemeDependencies } from "../../src/document-worker/dependencies.js";

const image = (background: string, webp = false) => {
  const source = sharp({ create: { width: 24, height: 16, channels: 3, background } });
  return webp ? source.webp().toBuffer() : source.png().toBuffer();
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "panda-profile-")),
    source = join(root, "blog");
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), data);
  };
  put("package.json", JSON.stringify({ dependencies: { hexo: "8.1.1" } }));
  put(
    "_config.base.yml",
    "title: Public journal\nurl: https://example.test\nauthor: Writer\ntimezone: Asia/Shanghai\ntheme: personal\nsource_dir: private-source\ndeploy:\n  password: hidden-value\ntheme_config:\n  brand: Public brand\n  api_key: never-copy-this\n",
  );
  put("_config.en.yml", "root: /\nblog_language: en\ntheme_config:\n  navigation:\n    label: Essays\n");
  put("_config.zh.yml", "title: 双语博客\nroot: /zh/\nblog_language: zh\n");
  const content =
    '---\ntitle: Original article\nslug: essay\ntranslation_key: essay\ndate: \'2026-11-06 12:00:00\'\ncover: diagram.png\ncover_width: 24\ncover_height: 16\n---\n\n{% figure "/assets/articles/essay/diagram.png" "Figure" %}\nCaption\n{% endfigure %}\n';
  put("source-en/_posts/essay.md", content);
  put("source-zh/_posts/essay.md", content.replace("Original article", "原始文章"));
  put("assets/css/blog.css", "body{color:#123456}");
  for (const [suffix, color] of [
    ["", "red"],
    ["-en", "blue"],
  ]) {
    put(`assets/articles/essay/diagram${suffix}.png`, await image(color!));
    put(`assets/articles/essay/diagram${suffix}.webp`, await image(color!, true));
  }
  const feature = createDocumentFeature({
    stateRoot: join(root, "state"),
    allowedRoots: [root],
    requireProject: () => ({}),
  });
  const space = await feature.service.createSpace({
    projectId: "project",
    code: "blog",
    name: "Blog",
    engine: "hexo",
    sourceMode: "external",
    sourceRoot: source,
    locale: "en",
  });
  const theme = await freezeTrustedBuildTheme(exampleThemePackage(), "journal");
  async function profile(locale = "en", version = feature.service.space(space.id).version) {
    const proposal = await feature.profiles.inspect(
      space.id,
      locale,
      ["_config.base.yml", locale === "en" ? "_config.en.yml" : "_config.zh.yml"],
      true,
    );
    return feature.profiles.save(space.id, proposal.profile, version);
  }
  const capture = () =>
    documentBuildSources({
      service: feature.service,
      assets: feature.assets,
      snapshots: feature.snapshots,
      captureTheme: async () => theme,
      profiles: feature.profiles,
    }).capture({
      id: randomUUID(),
      spaceId: space.id,
      engine: "hexo",
      title: "Journal",
      url: "https://example.test",
      basePath: "/",
      locale: "en",
    });
  return {
    root,
    source,
    put,
    space,
    feature,
    theme,
    profile,
    capture,
    content,
    close() {
      feature.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("configuration proposals retain public nested locale data and visibly omit operational and private fields", async () => {
  const f = await fixture();
  try {
    const result = await inspectSourceConfiguration(f.source, ["_config.base.yml", "_config.en.yml"]);
    expect(result.edition).toMatchObject({
      url: "https://example.test",
      basePath: "/",
      config: {
        author: "Writer",
        timezone: "Asia/Shanghai",
        theme_config: { brand: "Public brand", navigation: { label: "Essays" } },
      },
    });
    expect(result.omitted).toEqual(["theme", "source_dir", "deploy", "theme_config.api_key"]);
    expect(JSON.stringify(result)).not.toMatch(/never-copy-this|hidden-value/);
    for (const yaml of [
      "x: &a [1]\ny: *a",
      "x: 1\nx: 2",
      "x: !!js/function 'function(){}'",
      "x: !!timestamp 2026-01-01",
    ])
      expect(() => sourceYaml(yaml)).toThrow("invalidSourceConfiguration");
    expect(() => sourceYaml("x: " + "a".repeat(65536))).toThrow("tooLarge");
    await expect(inspectSourceConfiguration(f.source, ["../outside.yml"])).rejects.toThrow("invalidInput");
    f.put("_config.unsafe.yml", "title: Test\nurl: https://user:password@example.test/\n");
    await expect(inspectSourceConfiguration(f.source, ["_config.unsafe.yml"])).rejects.toThrow(
      "invalidSourceConfiguration",
    );
  } finally {
    f.close();
  }
});

test("profile updates share the space optimistic lock and preserve the other language edition", async () => {
  const f = await fixture();
  try {
    const initial = f.space.version,
      first = await f.profile();
    expect(first.version).toBe(initial + 1);
    const en = f.feature.profiles.get(f.space.id)!.editions.en;
    await expect(f.profile("zh-CN", initial)).rejects.toThrow("spaceConflict");
    expect(f.feature.profiles.get(f.space.id)!.editions).toEqual({ en });
    await f.profile("zh-CN");
    expect(f.feature.profiles.get(f.space.id)!.editions).toMatchObject({
      en,
      "zh-CN": { title: "双语博客", basePath: "/zh/" },
    });
    await expect(f.feature.profiles.capture(f.space.id, "fr")).rejects.toThrow("sourceEditionMissing");
    expect(
      sourceImagePolicy(
        f.feature.profiles.get(f.space.id),
        "en",
        "---\ncover: https://example.test/image.png\nslug: essay\n---\n",
      )!.metadataSources,
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("locale originals and WebP companions freeze in revisions; historical builds cannot mix current host pixels", async () => {
  const f = await fixture();
  try {
    await f.profile();
    await f.profile("zh-CN");
    const imported = await f.feature.service.importSource(f.space.id);
    expect(imported.assets?.issues).toEqual([]);
    const docs = f.feature.service.listDocuments(f.space.id, "", 0).documents;
    const en = f.feature.service.detail(docs.find((doc) => doc.locale === "en")!.id),
      zh = f.feature.service.detail(docs.find((doc) => doc.locale === "zh-CN")!.id);
    expect(en.revision.resources!.find((item) => item.source.includes("diagram.png"))!.sourcePath).toBe(
      "assets/articles/essay/diagram-en.png",
    );
    expect(zh.revision.resources!.find((item) => item.source.includes("diagram.png"))!.sourcePath).toBe(
      "assets/articles/essay/diagram.png",
    );
    expect(en.revision.content).toBe(f.content);
    const old = await f.capture(),
      path = "assets/articles/essay/diagram-en.webp",
      oldHash = old.input.project!.files.find((file) => file.path === path)!.sha256;
    expect(old.input.documents[0]!.metadata).toMatchObject({
      slug: "essay",
      date: "2026-11-06 12:00:00",
      cover: "/assets/articles/essay/diagram-en.png",
    });
    expect(old.input.documents[0]!.content).toContain('{% figure "/assets/articles/essay/diagram-en.png"');
    expect(old.input.assets).toEqual([]);
    f.put(path, await image("green", true));
    expect((await f.capture()).input.project!.files.find((file) => file.path === path)!.sha256).toBe(oldHash);
    expect((await f.feature.service.importSource(f.space.id)).assets!.updatedDocuments).toBe(1);
    const latest = await f.capture();
    expect(latest.input.project!.files.find((file) => file.path === path)!.sha256).not.toBe(oldHash);
    f.feature.service.saveDocument(en.document.id, {
      ...en.revision,
      revision: f.feature.service.detail(en.document.id).document.revision,
      restoreRevisionId: en.revision.id,
    });
    expect((await f.capture()).input.project!.files.find((file) => file.path === path)!.sha256).toBe(oldHash);
    expect(await verifyBuildProject(old.input.project!)).toEqual(old.input.project!);
    expect(readFileSync(join(f.source, "source-en/_posts/essay.md"), "utf8")).toBe(f.content);
  } finally {
    f.close();
  }
});

test("source profile cannot change between image staging and transaction commit", async () => {
  const f = await fixture();
  try {
    await f.profile();
    const stage = f.feature.assets.stage.bind(f.feature.assets);
    let changed = false;
    f.feature.assets.stage = async (...args) => {
      const result = await stage(...args);
      if (!changed) {
        changed = true;
        await f.profile();
      }
      return result;
    };
    await expect(f.feature.service.importSource(f.space.id)).rejects.toThrow("spaceConflict");
    expect(f.feature.service.listDocuments(f.space.id, "", 0).documents).toEqual([]);
  } finally {
    f.close();
  }
});

test("shared output paths cannot combine conflicting revision-owned image versions", async () => {
  const f = await fixture();
  try {
    f.put(
      "source-en/_posts/other.md",
      f.content
        .replace("slug: essay", "slug: other")
        .replace("cover: diagram.png", "cover: /assets/articles/essay/diagram.png"),
    );
    await f.profile();
    await f.feature.service.importSource(f.space.id);
    const record = f.feature.service
      .listDocuments(f.space.id, "", 0)
      .documents.find((doc) => doc.path.endsWith("/other.md"))!;
    const detail = f.feature.service.detail(record.id);
    f.feature.service.saveDocument(record.id, {
      ...detail.revision,
      revision: record.revision,
      content: detail.revision.content + "\nLocal draft",
    });
    f.put("assets/articles/essay/diagram-en.webp", await image("green", true));
    await f.feature.service.importSource(f.space.id);
    await expect(f.capture()).rejects.toThrow("sourceResourceConflict");
  } finally {
    f.close();
  }
});

test("project input rejects control config, file aliases, undeclared metadata and tampered resources", async () => {
  const f = await fixture();
  try {
    await f.profile();
    await f.feature.service.importSource(f.space.id);
    const { input } = await f.capture();
    expect(requiresSiteProjectProtocol(input)).toBe(true);
    const project = input.project!,
      first = project.files[0]!;
    for (const config of [{ source_dir: "/outside" }, { theme: "other" }, { theme_config: { api_key: "secret" } }])
      expect(() => buildProject({ ...project, config })).toThrow("invalidSiteProject");
    for (const files of [
      [first, { ...first, path: first.path.toUpperCase().replace(/^ASSETS\//, "assets/") }],
      [
        { ...first, path: "assets/theme.css" },
        { ...first, path: "assets/theme.css/child.css" },
      ],
      [
        { ...first, path: "assets/Art/a.css" },
        { ...first, path: "assets/art/b.css" },
      ],
    ])
      expect(() => buildProject({ ...project, files })).toThrow("invalidSiteProject");
    await expect(verifyBuildProject({ ...project, files: [{ ...first, sha256: "0".repeat(64) }] })).rejects.toThrow(
      "inputDigestMismatch",
    );
    expect(() =>
      buildInput({ ...input, documents: [{ ...input.documents[0]!, metadata: { raw: "bypass" } }] }),
    ).toThrow("invalidSiteProject");
    for (const meta of [{ date: "not a date" }, { slug: "../outside" }, { published: "false" }, { cover_width: 0 }])
      expect(() => publicDocumentMetadata(meta)).toThrow();
    expect(() => metadataFieldNames(["secret_key"])).toThrow();
    expect(publicDocumentMetadata({ custom_label: "Editorial" }, ["custom_label"])).toEqual({
      custom_label: "Editorial",
    });
  } finally {
    f.close();
  }
});

test("engine projection retains post routes, pages and unpublished drafts", () => {
  const doc = {
    id: "a",
    path: "source-en/_posts/original.md",
    title: "Original",
    content: "---\ntitle: Old\n---\nBody",
    metadata: { slug: "public-slug", date: "2026-11-06 12:00:00" },
  };
  const post = hexoDocument(doc);
  expect(post.path).toMatch(/^source\/_posts\/[a-f0-9]{64}\.md$/);
  expect(post.content).toContain('permalink: "posts/public-slug/"');
  expect(post.content).toContain('date: "2026-11-06 12:00:00"');
  expect(hexoDocument({ ...doc, path: "source-en/search/index.md", metadata: { layout: "search" } }).path).toBe(
    "source/search/index.md",
  );
  expect(hexoDocument({ ...doc, path: "source-en/_drafts/essay.md" }).path).toContain("source/_drafts/");
  expect(hexoDocument({ ...doc, metadata: { published: false } }).path).toContain("source/_drafts/");
});

test("source theme packaging reads only a selected theme and never executes its scripts", async () => {
  const f = await fixture();
  try {
    f.put("themes/journal/layout/layout.ejs", "<%- body %>");
    f.put("themes/journal/scripts/guard.js", "throw Error('must never execute in app');");
    f.put("themes/journal/.env", "do-not-export");
    f.put("themes/journal/.codex/config.json", "do-not-export");
    const manifest = structuredClone(f.theme.bundle.manifest);
    manifest.siteThemes = [manifest.siteThemes[0]!];
    manifest.siteThemes[0]!.root = "theme";
    manifest.channelTemplates = [];
    manifest.permissions = ["content:site-themes", "build:theme-code"];
    const pack = documentThemePackager(f.feature.service);
    const result = await pack(f.space.id, "journal", manifest);
    expect(result.fileCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("do-not-export");
    expect((await pack(f.space.id, "journal", manifest)).digest).toBe(result.digest);
    const asyncPack = documentThemePackager({
      space: async (id) => {
        await Promise.resolve();
        return f.feature.service.space(id);
      },
      sources: f.feature.service.sources,
    });
    expect((await asyncPack(f.space.id, "journal", manifest)).digest).toBe(result.digest);
    let metadataReads = 0;
    const changed = documentThemePackager({
      space: async (id) => {
        const space = f.feature.service.space(id);
        return { ...space, version: space.version + (metadataReads++ ? 1 : 0) };
      },
      sources: f.feature.service.sources,
    });
    await expect(changed(f.space.id, "journal", manifest)).rejects.toThrow("packageDigestMismatch");
    f.put("themes/日记/layout/layout.ejs", "<%- body %>");
    expect((await pack(f.space.id, "日记", manifest)).fileCount).toBe(1);
    await expect(pack(f.space.id, "../outside", manifest)).rejects.toThrow("invalidPackage");
    symlinkSync(join(f.source, "_config.base.yml"), join(f.source, "themes/journal/private.yml"));
    await expect(pack(f.space.id, "journal", manifest)).rejects.toThrow("invalidPackagePath");
  } finally {
    f.close();
  }
});

test("theme dependencies are exact metadata checks and never cause installation", async () => {
  const f = await fixture();
  try {
    const bundle = exampleThemePackage();
    bundle.manifest.siteThemes[0].dependencies = { cheerio: "1.2.0" };
    const input = {
      protocol: 1,
      engine: "hexo",
      preset: "reader",
      site: { title: "Test", url: "https://example.test", basePath: "/", locale: "en" },
      documents: [{ id: "a", path: "a.md", title: "A", content: "A" }],
      assets: [],
      theme: await freezeTrustedBuildTheme(bundle, "journal"),
    } as const;
    expect(requiresSiteProjectProtocol(input)).toBe(true);
    await expect(verifyThemeDependencies(input, f.root)).rejects.toThrow("themeDependencyUnavailable");
    mkdirSync(join(f.root, "node_modules/cheerio"), { recursive: true });
    writeFileSync(join(f.root, "node_modules/cheerio/package.json"), JSON.stringify({ version: "1.2.0" }));
    await verifyThemeDependencies(input, f.root);
    writeFileSync(join(f.root, "node_modules/cheerio/package.json"), JSON.stringify({ version: "1.1.0" }));
    await expect(verifyThemeDependencies(input, f.root)).rejects.toThrow("themeDependencyUnavailable");
  } finally {
    f.close();
  }
});
