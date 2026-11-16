import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { createPluginFeature } from "../../src/server/plugins/integration/feature.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { verifyBuildTheme, buildThemeMetadata } from "../../src/shared/builds/theme.js";
import { buildInput } from "../../src/shared/builds/validation.js";
import { presentationText } from "../../src/shared/presentation/labels.js";
import { serverTranslator } from "../../src/server/i18n/messages.js";
import { scaffold } from "../../src/document-worker/scaffold.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { SiteBuildReconciler } from "../../src/server/builds/reconciler.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import type { BuildInput } from "../../src/shared/builds/contracts.js";
import type { SiteExecutor } from "../../src/server/builds/executor-port.js";
import type { PluginRegistryService } from "../../src/server/plugins/service.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import type { DockerApi } from "../../src/executor/docker/api.js";

const input: BuildInput = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "Blog", url: "https://example.test", basePath: "/", locale: "en" },
  documents: [{ id: "article", path: "article.md", title: "Article", content: "A saved source." }],
  assets: [],
};
const install = async (service: PluginRegistryService, version = "1.0.0") => {
  const value = exampleThemePackage(version),
    review = await service.review(value);
  return service.install(
    value,
    { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
    "fixture-owner",
  );
};

test("installed catalogs retain exact approved versions and freeze executable themes without exposing files in records", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-installed-catalog-"));
  const plugins = createPluginFeature({ stateRoot: root, owner: () => "fixture-owner" });
  const docs = createDocumentFeature({
    stateRoot: root,
    themes: plugins.themes,
    allowedRoots: [root],
    requireProject: () => ({}),
  });
  try {
    await install(plugins.service);
    const selected = plugins.themes.resolve("example.studio.journal@1.0.0", "hexo");
    expect(selected.kind).toBe("installed");
    expect(presentationText(serverTranslator("en"), selected, "name", "zh-CN")).toBe("示例主题");
    expect(presentationText(serverTranslator("en"), selected, "name", "de")).toBe("Studio");
    expect(() => plugins.themes.resolve("example.studio.journal@1.0.0", "docusaurus")).toThrow("incompatibleTheme");
    const space = await docs.service.createSpace({
      projectId: "project",
      code: "blog",
      name: "Blog",
      engine: "hexo",
      theme: "example.studio.journal@1.0.0",
      sourceMode: "managed",
    });
    docs.service.createDocument({ spaceId: space.id, path: "article.md", title: "Article", content: "Saved source." });
    const sources = documentBuildSources({
        service: docs.service,
        assets: docs.assets,
        snapshots: docs.snapshots,
        captureTheme: plugins.captureTheme,
      }),
      request = { id: randomUUID(), spaceId: space.id, engine: "hexo" as const, ...input.site },
      capture = await sources.capture(request),
      jobs = new SiteBuildRepository(docs.persistence);
    expect(capture.input.theme?.schema).toBe(2);
    expect(await verifyBuildTheme(capture.input.theme, "hexo")).toEqual(capture.input.theme!);
    const job = jobs.create(request, capture.input, capture.sources);
    expect(JSON.stringify(job)).not.toContain("base64");
    expect(JSON.stringify(job)).not.toContain("<main>");
    expect("bundle" in job.theme!).toBe(false);
    expect(jobs.input(job.id)).toEqual(capture.input);
    await install(plugins.service, "2.0.0");
    expect(plugins.templates.resolve("example.studio.paper").version).toBe("2.0.0");
    expect(plugins.templates.resolve("example.studio.paper", "1.0.0").version).toBe("1.0.0");
    expect((await sources.capture({ ...request, id: randomUUID() })).input.theme?.version).toBe("1.0.0");
    plugins.service.setEnabled("example.studio", "1.0.0", false, 2, "fixture-owner");
    expect(() => plugins.authorizeBuild(capture.input)).toThrow("themeNotApproved");
    expect(jobs.input(job.id)).toEqual(capture.input);
    expect(() => plugins.templates.resolve("example.studio.paper", "1.0.0")).toThrow();
    expect(plugins.themes.resolve("default", "hexo").id).toBe("panda.reader");
  } finally {
    docs.close();
    plugins.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("executable snapshots reject content replacement, arbitrary image settings and unverified theme IO", async () => {
  const theme = await freezeTrustedBuildTheme(exampleThemePackage(), "journal");
  expect(buildInput({ ...input, theme }).theme).toEqual(theme);
  expect(buildThemeMetadata(theme)).not.toHaveProperty("bundle");
  const changed = structuredClone(theme);
  changed.bundle.files[0]!.data = Buffer.from("changed").toString("base64");
  await expect(verifyBuildTheme(changed, "hexo")).rejects.toThrow("themeDigestMismatch");
  expect(() => buildInput({ ...input, theme: { ...theme, image: "unapproved:latest" } })).toThrow("invalidTheme");
  const root = await mkdtemp(join(tmpdir(), "panda-trusted-scaffold-"));
  try {
    await scaffold({ ...input, theme }, join(root, "hexo"));
    expect(await readFile(join(root, "hexo/_config.yml"), "utf8")).toContain('theme: "panda-installed"');
    expect(await readFile(join(root, "hexo/themes/panda-installed/scripts/helpers.js"), "utf8")).toContain(
      "studioMarker",
    );
    await expect(readFile(join(root, "hexo/scripts/panda-semantic-tags.js"))).rejects.toThrow();
    const reference = await freezeTrustedBuildTheme(exampleThemePackage(), "reference");
    await scaffold({ ...input, engine: "docusaurus", preset: "handbook", theme: reference }, join(root, "docs"));
    expect(await readFile(join(root, "docs/docusaurus.config.js"), "utf8")).toContain(
      '"themes":["./panda-theme/index.js"]',
    );
    expect(await readFile(join(root, "docs/panda-theme/theme/Root/index.js"), "utf8")).toContain("data-trusted-theme");
    await expect(scaffold({ ...input, theme: changed }, join(root, "invalid"))).rejects.toThrow("themeDigestMismatch");
    await expect(readFile(join(root, "invalid/package.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch revocation blocks unaccepted work but still observes an accepted request after a lost response", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-trusted-dispatch-")),
    db = new Database(":memory:");
  try {
    const theme = await freezeTrustedBuildTheme(exampleThemePackage(), "journal"),
      snapshot = { ...input, theme },
      jobs = new SiteBuildRepository(db);
    for (const accepted of [false, true]) {
      const job = jobs.create({ id: randomUUID(), spaceId: "space", engine: "hexo", ...input.site }, snapshot, []);
      let starts = 0;
      const executor = {
        async status() {
          if (!accepted) throw new SiteBuildError("executorMissing", 404);
          return { ...job, phase: "running" };
        },
        async start() {
          starts++;
          throw Error("Revoked work must not start");
        },
        async logs() {
          return "";
        },
      } as unknown as SiteExecutor;
      const reconciler = new SiteBuildReconciler(
        jobs,
        new SiteBuildArtifacts(root),
        executor,
        () => {},
        undefined,
        () => {
          throw new SiteBuildError("themeNotApproved", 403);
        },
      );
      try {
        await reconciler.tick();
        expect(jobs.get(job.id).phase).toBe(accepted ? "running" : "failed");
        expect(jobs.get(job.id).error).toBe(accepted ? null : "themeNotApproved");
        expect(starts).toBe(0);
      } finally {
        reconciler.stop();
      }
      if (accepted) jobs.update(job.id, { phase: "cancelled" });
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("admin-selected worker images must advertise the executable-theme protocol separately", async () => {
  const labels: Record<string, string> = {
    "ai.hiforce.panda.build-protocol": "1",
    "ai.hiforce.panda.engine.hexo": "8.1.1",
    "ai.hiforce.panda.theme-protocol": "1",
  };
  const api = {
    call: async () => ({
      status: 200,
      data: Buffer.from(JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: labels } })),
    }),
  } as unknown as DockerApi;
  await expect(
    resolveWorkerImage(api, { reference: "harbor.example.test/worker:1", pullPolicy: "never" }, "hexo", {
      requirements: { themes: true, trustedThemes: true },
    }),
  ).rejects.toThrow("trustedThemeWorkerRequired");
  labels["ai.hiforce.panda.trusted-theme-protocol"] = "1";
  await expect(
    resolveWorkerImage(api, { reference: "harbor.example.test/worker:1", pullPolicy: "never" }, "hexo", {
      requirements: { themes: true, trustedThemes: true, siteProjects: true },
    }),
  ).rejects.toThrow("sourceProjectWorkerRequired");
  labels["ai.hiforce.panda.site-project-protocol"] = "1";
  expect(
    (
      await resolveWorkerImage(api, { reference: "harbor.example.test/worker:1", pullPolicy: "never" }, "hexo", {
        requirements: { themes: true, trustedThemes: true, siteProjects: true },
      })
    ).id,
  ).toBe("sha256:" + "a".repeat(64));
  expect(
    (
      await resolveWorkerImage(api, { reference: "harbor.example.test/worker:1", pullPolicy: "never" }, "hexo", {
        requirements: { themes: true, trustedThemes: true },
      })
    ).id,
  ).toBe("sha256:" + "a".repeat(64));
});

test("cancellation or shutdown during a read-only remote probe never dispatches new executable work", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-trusted-cancel-")),
    db = new Database(":memory:");
  try {
    const theme = await freezeTrustedBuildTheme(exampleThemePackage(), "journal"),
      jobs = new SiteBuildRepository(db);
    for (const mode of ["cancel", "shutdown"]) {
      const job = jobs.create(
        { id: randomUUID(), spaceId: "space", engine: "hexo", ...input.site },
        { ...input, theme },
        [],
      );
      let starts = 0,
        reconciler: SiteBuildReconciler;
      const executor = {
        async status() {
          if (mode === "cancel") jobs.update(job.id, { phase: "cancelling" });
          else reconciler.stop();
          throw new SiteBuildError("executorMissing", 404);
        },
        async cancel() {
          throw new SiteBuildError("executorMissing", 404);
        },
        async start() {
          starts++;
          throw Error("New work must not start");
        },
      } as unknown as SiteExecutor;
      reconciler = new SiteBuildReconciler(
        jobs,
        new SiteBuildArtifacts(root),
        executor,
        () => {},
        undefined,
        () => {},
      );
      try {
        await reconciler.tick();
        expect(starts).toBe(0);
        expect(jobs.get(job.id).phase).toBe(mode === "cancel" ? "cancelled" : "queued");
      } finally {
        reconciler.stop();
      }
      if (mode === "shutdown") jobs.update(job.id, { phase: "cancelled" });
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
