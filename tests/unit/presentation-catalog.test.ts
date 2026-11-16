import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { builtinSiteThemes, themeReference } from "../../src/shared/presentation/themes.js";
import { builtinChannelTemplates, type ChannelTemplateCatalog } from "../../src/shared/presentation/templates.js";
import { freezeBuildTheme, validateBuildTheme, verifyBuildTheme } from "../../src/shared/builds/theme.js";
import { buildInput } from "../../src/shared/builds/validation.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { createPublishingFeature } from "../../src/server/publishing/integration/feature.js";
import { scaffold } from "../../src/document-worker/scaffold.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import { ExecutionService } from "../../src/executor/service.js";
import { ExecutionStore } from "../../src/executor/store.js";
import type { BuildInput } from "../../src/shared/builds/contracts.js";
import type { DockerApi } from "../../src/executor/docker/api.js";

const legacy: BuildInput = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "Blog", url: "https://example.test", basePath: "/guide/", locale: "en" },
  documents: [{ id: "doc", path: "article.md", title: "Article", content: "A clear article." }],
  assets: [],
};
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("site catalog enforces exact versions and engine compatibility without sharing mutable state", () => {
  const list = builtinSiteThemes.list("hexo");
  expect(list).toHaveLength(2);
  expect(themeReference(builtinSiteThemes.resolve("default", "hexo"))).toBe("panda.reader@1.0.0");
  expect(themeReference(builtinSiteThemes.resolve("default", "docusaurus"))).toBe("panda.handbook@1.0.0");
  expect(() => builtinSiteThemes.validate("panda.missing@1.0.0", "hexo")).toThrow("unknownTheme");
  expect(() => builtinSiteThemes.validate("panda.journal@2.0.0", "hexo")).toThrow("unknownTheme");
  expect(() => builtinSiteThemes.resolve("panda.handbook@1.0.0", "hexo")).toThrow("incompatibleTheme");
  list[0]!.profile!.width = 1;
  expect(builtinSiteThemes.resolve("default", "hexo").profile!.width).toBe(880);
});

test("theme wire data has portable canonical identity and rejects scripts, unsafe CSS and tampering", async () => {
  const theme = await freezeBuildTheme(builtinSiteThemes.resolve("panda.journal@1.0.0", "hexo"));
  expect(await verifyBuildTheme(theme, "hexo")).toEqual(theme);
  expect(buildInput({ ...legacy, theme }).theme).toEqual(theme);
  expect(() => validateBuildTheme({ ...theme, command: "rm -rf /" }, "hexo")).toThrow("invalidTheme");
  expect(() =>
    validateBuildTheme({ ...theme, profile: { ...theme.profile, accent: "url(https://example.invalid)" } }, "hexo"),
  ).toThrow("invalidTheme");
  expect(() => validateBuildTheme({ ...theme, profile: { ...theme.profile, width: 100000 } }, "hexo")).toThrow(
    "invalidTheme",
  );
  await expect(
    verifyBuildTheme({ ...theme, profile: { ...theme.profile, accent: "#ffffff" } }, "hexo"),
  ).rejects.toThrow("themeDigestMismatch");
  expect(JSON.stringify(buildInput(legacy))).toBe(JSON.stringify(legacy));
});

test("space theme changes are optimistic and leave prior build input bytes and document revisions unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-theme-space-"));
  const docs = createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject: () => ({}) });
  try {
    const space = await docs.service.createSpace({
      projectId: "project",
      code: "blog",
      name: "Blog",
      engine: "hexo",
      sourceMode: "managed",
      theme: "panda.reader@1.0.0",
    });
    const document = docs.service.createDocument({
      spaceId: space.id,
      path: "article.md",
      title: "Article",
      content: "Source unchanged.",
    });
    const sources = documentBuildSources({ service: docs.service, assets: docs.assets, snapshots: docs.snapshots }),
      jobs = new SiteBuildRepository(docs.persistence);
    const request = { id: randomUUID(), spaceId: space.id, engine: "hexo" as const, ...legacy.site };
    const original = await sources.capture(request),
      job = jobs.create(request, original.input, original.sources);
    const before = JSON.stringify(jobs.input(job.id));
    const updated = docs.service.updateTheme(space.id, { version: space.version, theme: "panda.journal@1.0.0" });
    expect(updated.version).toBe(2);
    await expect(sources.capture({ ...request, id: randomUUID(), spaceVersion: 1 })).rejects.toThrow(
      "spaceSettingsChanged",
    );
    expect(() => docs.service.updateTheme(space.id, { version: 1, theme: "default" })).toThrow("spaceConflict");
    const current = await sources.capture({ ...request, id: randomUUID() });
    expect(current.input.theme?.id).toBe("panda.journal");
    expect(current.input.theme?.sha256).not.toBe(original.input.theme?.sha256);
    expect(jobs.get(job.id).theme?.id).toBe("panda.reader");
    expect(JSON.stringify(jobs.input(job.id))).toBe(before);
    expect(docs.service.detail(document.document.id).document.revision).toBe(1);
    await expect(sources.capture({ ...request, id: randomUUID(), engine: "docusaurus" })).rejects.toThrow(
      "incompatibleTheme",
    );
  } finally {
    docs.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("theme versions change real Hexo and Docusaurus scaffold styles, while checksum failure writes no site", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-theme-scaffold-"));
  try {
    const journal = await freezeBuildTheme(builtinSiteThemes.resolve("panda.journal@1.0.0", "hexo"));
    await scaffold({ ...legacy, theme: journal }, join(root, "journal"));
    const layout = await readFile(join(root, "journal/themes/panda-reader/layout/layout.ejs"), "utf8");
    expect(layout).toContain("Georgia,Charter,serif");
    expect(layout).toContain("#845738");
    expect(layout).toContain("max-width:760px");
    const reference = await freezeBuildTheme(builtinSiteThemes.resolve("panda.reference@1.0.0", "docusaurus"));
    await scaffold({ ...legacy, engine: "docusaurus", preset: "handbook", theme: reference }, join(root, "reference"));
    expect(await readFile(join(root, "reference/src/css/panda-theme.css"), "utf8")).toContain(
      "--ifm-container-width:1280px",
    );
    expect(await readFile(join(root, "reference/docusaurus.config.js"), "utf8")).toContain("customCss");
    await expect(
      scaffold({ ...legacy, theme: { ...journal, sha256: "0".repeat(64) } }, join(root, "bad")),
    ).rejects.toThrow("themeDigestMismatch");
    await expect(readFile(join(root, "bad/package.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executor verifies theme identity before persisting jobs and rejects old worker images for themed jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-theme-executor-"));
  const store = new ExecutionStore(root),
    service = new ExecutionService(
      store,
      {
        async run() {
          throw Error("Must not run");
        },
        async cleanup() {},
      },
      () => {},
    );
  try {
    const theme = await freezeBuildTheme(builtinSiteThemes.resolve("default", "hexo"));
    await expect(
      service.start(randomUUID(), { ...legacy, theme: { ...theme, profile: { ...theme.profile, accent: "#ffffff" } } }),
    ).rejects.toThrow("themeDigestMismatch");
    expect(store.ids()).toEqual([]);
    const labels: Record<string, string> = {
      "ai.hiforce.panda.build-protocol": "1",
      "ai.hiforce.panda.engine.hexo": "8.1.1",
    };
    const api = {
      call: async () => ({
        status: 200,
        data: Buffer.from(JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: labels } })),
      }),
    } as unknown as DockerApi;
    await expect(
      resolveWorkerImage(api, { reference: "harbor.example.test/team/worker:1", pullPolicy: "never" }, "hexo", {
        requirements: { themes: true },
      }),
    ).rejects.toThrow("themeWorkerRequired");
    labels["ai.hiforce.panda.theme-protocol"] = "1";
    expect(
      (
        await resolveWorkerImage(api, { reference: "harbor.example.test/team/worker:1", pullPolicy: "never" }, "hexo", {
          requirements: { themes: true },
        })
      ).id,
    ).toBe("sha256:" + "a".repeat(64));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("declarative template ports freeze custom styles and remain exportable after their catalog changes", async () => {
  const db = new Database(":memory:");
  let version = "1",
    available = true;
  const template = () => ({
    ...builtinChannelTemplates.resolve("technical"),
    id: "example.research",
    version,
    style: { ...builtinChannelTemplates.resolve("technical").style, version, accent: "#884422" },
  });
  const catalogue: ChannelTemplateCatalog = {
    list: () => (available ? [template()] : []),
    resolve: (_id, expected) => {
      if (!available) throw Error("removed");
      if (expected && expected !== version) throw Error("stale");
      return template();
    },
  };
  const feature = createPublishingFeature(
    db,
    {
      authorize: () => () => {},
      current: () => ({ revisionId: "rev" }),
      revision: () => ({
        documentId: "doc",
        revisionId: "rev",
        title: "Article",
        locale: "en",
        content: "# Heading\n\nA clear [reference](https://example.test).",
        engine: "markdown",
      }),
    },
    {
      async content() {
        throw Error("No images");
      },
    },
    catalogue,
  );
  try {
    const prepared = await feature.variants.prepare({
      documentId: "doc",
      revisionId: "rev",
      mode: "format",
      format: "html",
      templateId: "example.research",
      templateVersion: "1",
    });
    expect(prepared.variant.templateSnapshot?.id).toBe("example.research");
    expect(prepared.variant.templateDigest).toBe(sha(prepared.variant.templateSnapshot));
    expect(prepared.variant.html).toContain("#884422");
    version = "2";
    available = false;
    const output = await feature.exporter.export(prepared.variant.id, "bundle");
    const files = unzipSync(output.bytes);
    expect(strFromU8(files["article.html"]!)).toContain("#884422");
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest.template.version).toBe("1");
    expect(manifest.template.digest).toBe(prepared.variant.templateDigest);
    expect((await feature.variants.detail(prepared.variant.id)).digest).toBe(prepared.digest);
  } finally {
    db.close();
  }
});

test("template selection checks versions and rejects unsafe plugin style values", async () => {
  const db = new Database(":memory:");
  const source = {
    documentId: "doc",
    revisionId: "rev",
    title: "A",
    locale: "en",
    content: "Text",
    engine: "markdown" as const,
  };
  const feature = createPublishingFeature(
    db,
    { authorize: () => () => {}, current: () => ({ revisionId: "rev" }), revision: () => source },
    {
      async content() {
        throw Error("No images");
      },
    },
  );
  try {
    await expect(
      feature.variants.prepare({
        documentId: "doc",
        revisionId: "rev",
        mode: "format",
        format: "html",
        templateId: "editorial",
        templateVersion: "2",
      }),
    ).rejects.toThrow("staleTemplate");
    const unsafe = {
      ...builtinChannelTemplates.resolve("technical"),
      style: { ...builtinChannelTemplates.resolve("technical").style, font: "url(https://example.invalid)" },
    };
    const bad = createPublishingFeature(
      db,
      { authorize: () => () => {}, current: () => ({ revisionId: "rev" }), revision: () => source },
      {
        async content() {
          throw Error("No images");
        },
      },
      { list: () => [unsafe], resolve: () => unsafe },
    );
    await expect(
      bad.variants.prepare({
        documentId: "doc",
        revisionId: "rev",
        mode: "format",
        format: "html",
        templateId: "technical",
      }),
    ).rejects.toThrow("invalidTemplate");
  } finally {
    db.close();
  }
});

test("an older executor stays discoverable but cannot receive a new themed job", async () => {
  const { writeFileSync } = await import("node:fs");
  const { HttpSiteExecutor } = await import("../../src/server/builds/adapters/http-executor.js");
  const { SiteBuildService } = await import("../../src/server/builds/service.js");
  const { SiteBuildArtifacts } = await import("../../src/server/builds/artifacts.js");
  const root = mkdtempSync(join(tmpdir(), "panda-theme-legacy-")),
    db = new Database(":memory:");
  try {
    const token = join(root, "token");
    writeFileSync(token, "a".repeat(64));
    const remote = new HttpSiteExecutor(
      "http://127.0.0.1:1234",
      token,
      Object.assign(async () => Response.json({ protocol: 1, engines: { hexo: "8.1.1", docusaurus: "3.10.2" } }), {
        preconnect() {},
      }),
    );
    const available = await remote.availability();
    expect(available.state).toBe("ready");
    expect(available.themes).toBe(false);
    const theme = await freezeBuildTheme(builtinSiteThemes.resolve("default", "hexo"));
    const jobs = new SiteBuildRepository(db),
      spaceId = randomUUID();
    const service = new SiteBuildService(
      {
        authorize() {},
        async capture() {
          return { input: { ...legacy, theme }, sources: [] };
        },
      },
      jobs,
      new SiteBuildArtifacts(root),
      remote,
      null,
    );
    await expect(service.start({ id: randomUUID(), spaceId, engine: "hexo", ...legacy.site })).rejects.toThrow(
      "themeExecutorRequired",
    );
    expect(jobs.list(spaceId)).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
