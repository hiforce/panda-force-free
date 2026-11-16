import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "../../src/server/http/router.js";
import type { SiteBuildRequest } from "../../src/shared/builds/jobs.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { projectDocumentBuildSources } from "../../src/server/builds/integration/project-document-sources.js";
import { createSiteBuildFeature } from "../../src/server/builds/integration/feature.js";
import { nativeBuildThemes } from "../../src/server/templates/integration/native-build-themes.js";
import { nativeThemeFixture, nativeZipSource } from "./native-theme.js";
import { projectFileApiFixture } from "./project-file-api-fixture.js";
import { createSampleExecutorHttp } from "./site-sample-http.js";

export async function nativeProjectBuildFixture() {
  const routes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes: routes }),
    native = await nativeThemeFixture(),
    executor = await createSampleExecutorHttp({ native: true }),
    root = await mkdtemp(join(tmpdir(), "panda-native-project-")),
    tokenFile = join(root, "executor-token"),
    projectId = "project-1",
    actor = "owner",
    author = { name: "Project author", email: "project@example.test" };
  await writeFile(tokenFile, executor.token, { mode: 0o600 });
  let themeService = native.service(),
    db = new Database(join(root, "builds.sqlite")),
    feature: ReturnType<typeof createSiteBuildFeature>,
    legacyCaptures = 0;
  const space = await f.application().spaces.create(actor, {
    operationId: randomUUID(),
    projectId,
    code: "native",
    name: "Native project",
    engine: "hexo",
    sourceMode: "managed",
    locale: "en",
    theme: "default",
  });
  function open() {
    feature = createSiteBuildFeature({
      db,
      stateRoot: root,
      executorUrl: executor.url,
      tokenFile,
      owner: (context) =>
        typeof context.req.headers["x-fixture-owner"] === "string" ? context.req.headers["x-fixture-owner"] : actor,
      nativeThemes: nativeBuildThemes(themeService),
      inputBudget: native.owned.ingestion.runtime,
      sources: projectDocumentBuildSources({
        ...f.application(),
        themes: builtinSiteThemes,
        captureTheme: async () => {
          legacyCaptures++;
          throw Error("Native capture must not resolve a legacy theme");
        },
      }),
    });
    routes.splice(0, routes.length, ...feature.routes);
  }
  open();
  return {
    f,
    root,
    native,
    executor,
    projectId,
    actor,
    author,
    space,
    get service() {
      return feature.service;
    },
    get db() {
      return db;
    },
    get themes() {
      return themeService;
    },
    get legacyCaptures() {
      return legacyCaptures;
    },
    async install() {
      const { source } = await nativeZipSource(),
        command = await native.command(themeService, source),
        installed = await themeService.install(actor, command.input),
        theme = installed.current.themes[0]!;
      return { id: theme.id, version: theme.version, digest: theme.digest };
    },
    request(theme: NonNullable<SiteBuildRequest["nativeTheme"]>): SiteBuildRequest {
      return {
        id: randomUUID(),
        projectId,
        spaceId: space.id,
        engine: "hexo",
        title: "Native project site",
        locale: "en",
        url: "https://example.test",
        basePath: "/docs/",
        nativeTheme: theme,
      };
    },
    async place(revisionId: string | null = null) {
      return f.application().placements.create(actor, projectId, {
        operationId: randomUUID(),
        id: randomUUID(),
        documentId: "doc-1",
        spaceId: space.id,
        spaceVersion: (await f.application().spaces.get(projectId, space.id)).space.version,
        path: "article.md",
        locale: "en",
        revisionId,
      });
    },
    async restart() {
      await feature.close();
      db.close();
      themeService = await native.restart();
      f.reopen();
      db = new Database(join(root, "builds.sqlite"));
      open();
    },
    async close() {
      await feature.close();
      db.close();
      await executor.stop();
      await f.close();
      await native.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
