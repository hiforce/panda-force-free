import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Route } from "../../src/server/http/router.js";
import type { SiteBuildRequest, SiteBuild } from "../../src/shared/builds/jobs.js";
import type { SiteExecutor } from "../../src/server/builds/executor-port.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { freezeBuildTheme } from "../../src/shared/builds/theme.js";
import { projectDocumentBuildSources } from "../../src/server/builds/integration/project-document-sources.js";
import { routeProjectBuildSources } from "../../src/server/builds/integration/source-routing.js";
import { siteBuildRoutes } from "../../src/server/builds/integration/routes.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SiteBuildService } from "../../src/server/builds/service.js";
import { SiteBuildPreview } from "../../src/server/builds/preview.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";

const projectId = "project-1",
  actor = "test:build",
  author = { name: "Build test", email: "build@example.test" };
const executor: SiteExecutor = {
  availability: async () => ({
    state: "ready",
    themes: true,
    siteProjects: true,
    engines: { hexo: "8.1.1", docusaurus: "3.10.2" },
  }),
  start: async () => {
    throw new Error("This fixture verifies capture without dispatching a worker");
  },
  status: async () => {
    throw new Error("No worker started");
  },
  cancel: async () => {
    throw new Error("No worker started");
  },
  result: async () => {
    throw new Error("No worker started");
  },
  logs: async () => "",
};
async function fixture() {
  const extraRoutes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes }),
    root = await mkdtemp(join(tmpdir(), "panda-file-build-jobs-")),
    artifacts = new SiteBuildArtifacts(join(root, "artifacts")),
    space = await f.application().spaces.create(actor, {
      operationId: randomUUID(),
      projectId,
      code: "site",
      name: "Site",
      engine: "hexo",
      sourceMode: "managed",
      locale: "en",
      theme: "default",
    });
  let db = new Database(join(root, "jobs.sqlite")),
    jobs: SiteBuildRepository,
    service: SiteBuildService;
  function reopen() {
    jobs = new SiteBuildRepository(db);
    const sources = projectDocumentBuildSources({ ...f.application(), themes: builtinSiteThemes });
    service = new SiteBuildService(sources, jobs, artifacts, executor, null);
    extraRoutes.splice(0, extraRoutes.length, ...siteBuildRoutes(service, new SiteBuildPreview(service, artifacts)));
  }
  reopen();
  const request = (): SiteBuildRequest => ({
    id: randomUUID(),
    projectId,
    spaceId: space.id,
    engine: "hexo",
    title: "Saved site",
    locale: "en",
    url: "https://example.test",
    basePath: "/docs/",
  });
  return {
    f,
    root,
    artifacts,
    space,
    request,
    jobs: () => jobs,
    service: () => service,
    async link(revisionId: string | null = null) {
      return f.application().placements.create(actor, projectId, {
        operationId: randomUUID(),
        id: randomUUID(),
        documentId: "doc-1",
        spaceId: space.id,
        spaceVersion: (await f.application().spaces.get(projectId, space.id)).space.version,
        path: "article.md",
        locale: "en",
        revisionId,
        metadata: { title: "Target title" },
      });
    },
    restart() {
      db.close();
      db = new Database(join(root, "jobs.sqlite"));
      f.reopen();
      reopen();
    },
    async close() {
      db.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.concurrent(
  "file build HTTP requests persist project scope, immutable inputs and Git provenance across restart and later edits",
  async () => {
    const t = await fixture();
    try {
      const { f } = t,
        bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#3a6c90" } })
          .png()
          .toBuffer(),
        asset = await f.application().assets.upload(actor, projectId, "doc-1", "diagram.png", randomUUID(), bytes),
        original = projectDocumentFixture(
          2,
          "doc-1",
          `Saved source\n\n![diagram](/api/document-assets/content?id=${asset.id})\n`,
        );
      await f.project.documents.put(original, 1, "saved-with-image", author);
      const link = await t.link(original.revision.id);
      await f.application().editor.autosave(actor, projectId, "doc-1", {
        operationId: randomUUID(),
        version: 0,
        baseRevisionId: original.revision.id,
        working: { title: "Working-only", locale: "en", content: "Not saved", resources: [] },
      });
      const head = await f.snapshots.head(),
        request = t.request(),
        response = await f.call("/api/site-builds", "POST", request);
      expect(response.status).toBe(202);
      const job = response.body.build,
        input = t.jobs().input(job.id);
      expect(job.projectId).toBe(projectId);
      expect(job.sourceSnapshot).toEqual({ projectId, commit: head, spaceVersion: 2 });
      expect(job.sources[0]).toMatchObject({
        revisionId: original.revision.id,
        sourcePath: "doc-1.md",
        path: "article.md",
        placement: { id: link.id, version: 1 },
      });
      expect(input.documents[0]!.content).toContain("Saved source");
      expect(input.documents[0]!.content).not.toContain("Not saved");
      expect(input.documents[0]!.content).not.toContain("/api/document-assets/");
      expect(input.documents[0]!.title).toBe("Target title");
      expect(Buffer.from(input.assets[0]!.data, "base64")).toEqual(bytes);
      await f.project.documents.put(projectDocumentFixture(3, "doc-1", "Later saved body"), 2, "later", author);
      t.restart();
      expect((await f.call("/api/site-builds", "POST", request)).body.build).toEqual(job);
      expect(t.jobs().input(job.id)).toEqual(input);
      expect(
        (await f.call(`/api/site-builds?space=${t.space.id}&project=${projectId}`)).body.builds.map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual([job.id]);
      expect((await f.call("/api/site-builds/detail?id=" + job.id)).body.build.sourceSnapshot.commit).toBe(head);
      expect((await f.call("/api/site-builds", "POST", { ...request, projectId: "foreign" })).status).toBe(404);
      expect((await f.call("/api/site-builds", "POST", { ...request, title: "Changed" })).status).toBe(409);
      f.grants.delete(projectId);
      expect((await f.call("/api/site-builds/detail?id=" + job.id)).status).toBe(404);
      expect((await f.call(`/api/site-builds?space=${t.space.id}&project=${projectId}`)).status).toBe(404);
      expect((await f.call("/api/site-builds", "POST", request)).status).toBe(404);
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "file build projection freezes saved sources during later edits and rejects a changed destination before enqueue",
  async () => {
    const t = await fixture();
    try {
      await t.link();
      const { f } = t;
      const changingSource = projectDocumentBuildSources({
        ...f.application(),
        themes: builtinSiteThemes,
        async captureTheme(theme) {
          await f.project.documents.put(
            projectDocumentFixture(2, "doc-1", "A later revision"),
            1,
            "later-source",
            author,
          );
          return freezeBuildTheme(theme);
        },
      });
      const frozen = await changingSource.capture(t.request());
      expect(frozen.input.documents[0]!.content).toContain("Exact source");
      expect(frozen.sources[0]!.revisionId).toBe(f.detail.revision.id);
      expect((await f.application().queries.detail(projectId, "doc-1")).revision.content).toBe("A later revision");
      const changingTarget = projectDocumentBuildSources({
        ...f.application(),
        themes: builtinSiteThemes,
        async captureTheme(theme) {
          await f.application().spaces.configure(actor, projectId, t.space.id, {
            operationId: randomUUID(),
            version: 2,
            name: "Different settings",
          });
          return freezeBuildTheme(theme);
        },
      });
      const guarded = new SiteBuildService(changingTarget, t.jobs(), t.artifacts, executor, null);
      await expect(guarded.start(t.request())).rejects.toMatchObject({ code: "spaceSettingsChanged", status: 409 });
      expect(t.jobs().active()).toEqual([]);
      const handbook = await projectDocumentBuildSources({ ...f.application(), themes: builtinSiteThemes }).capture({
        ...t.request(),
        engine: "docusaurus",
      });
      expect(handbook.input.engine).toBe("docusaurus");
      expect(handbook.input.documents[0]!.content).toContain("A later revision");
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "scoped build routes cannot fall back to legacy storage, and artifact access rechecks asynchronous authorization",
  async () => {
    const t = await fixture();
    try {
      await t.link();
      const scoped = projectDocumentBuildSources({ ...t.f.application(), themes: builtinSiteThemes });
      let legacyCalls = 0;
      const routed = routeProjectBuildSources(
        {
          authorize() {
            legacyCalls++;
            throw new SiteBuildError("notFound", 404);
          },
          capture: async () => {
            throw new Error("No legacy capture");
          },
        },
        scoped,
      );
      await expect(Promise.resolve().then(() => routed.authorize(t.space.id))).rejects.toMatchObject({
        code: "notFound",
      });
      expect(legacyCalls).toBe(1);
      await expect(Promise.resolve().then(() => routed.authorize(t.space.id, "foreign"))).rejects.toMatchObject({
        code: "notFound",
      });
      expect(legacyCalls).toBe(1);
      const job = await t.service().start(t.request()),
        text = "<h1>Saved result</h1>";
      await t.artifacts.put(job.id, {
        protocol: 1,
        files: [
          {
            path: "index.html",
            data: Buffer.from(text).toString("base64"),
            sha256: createHash("sha256").update(text).digest("hex"),
          },
        ],
        bytes: Buffer.byteLength(text),
      });
      t.jobs().update(job.id, { phase: "completed", artifactAvailable: true });
      const preview = new SiteBuildPreview(t.service(), t.artifacts);
      expect(await preview.pages(job.id)).toEqual(["index.html"]);
      t.f.grants.delete(projectId);
      await expect(preview.pages(job.id)).rejects.toMatchObject({ code: "notFound", status: 404 });
      await expect(t.service().download(job.id)).rejects.toMatchObject({ code: "notFound", status: 404 });
      await expect(t.service().publicationSnapshot(job.id)).rejects.toMatchObject({ code: "notFound", status: 404 });
    } finally {
      await t.close();
    }
  },
  30000,
);

test("build job schema upgrade preserves legacy request identity and separates explicitly scoped history", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE site_build_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO site_build_schema VALUES(1,1); CREATE TABLE site_builds(id TEXT PRIMARY KEY,spaceId TEXT NOT NULL,request TEXT NOT NULL,record TEXT NOT NULL,input TEXT,logs TEXT NOT NULL DEFAULT '',createdAt INTEGER NOT NULL,terminal INTEGER NOT NULL DEFAULT 0)",
    );
    const request = {
        id: randomUUID(),
        spaceId: randomUUID(),
        engine: "hexo",
        title: "Legacy",
        locale: "en",
        url: "https://example.test",
        basePath: "/",
      } as const,
      job: SiteBuild = {
        id: request.id,
        spaceId: request.spaceId,
        engine: request.engine,
        preset: "reader",
        site: { title: request.title, locale: request.locale, url: request.url, basePath: request.basePath },
        sources: [],
        inputHash: "a".repeat(64),
        phase: "queued",
        createdAt: 0,
        updatedAt: 0,
        error: null,
        connection: "ready",
        outputBytes: 0,
        fileCount: 0,
        artifactAvailable: false,
        image: null,
      };
    db.query("INSERT INTO site_builds(id,spaceId,request,record,createdAt) VALUES(?,?,?,?,0)").run(
      job.id,
      job.spaceId,
      JSON.stringify(request),
      JSON.stringify(job),
    );
    const jobs = new SiteBuildRepository(db);
    expect(jobs.existing(request)).toEqual(job);
    expect(jobs.list(job.spaceId)).toEqual([job]);
    expect(jobs.list(job.spaceId, undefined, projectId)).toEqual([]);
    expect(new SiteBuildRepository(db).existing(request)).toEqual(job);
  } finally {
    db.close();
  }
});
