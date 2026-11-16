import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

const workspace = await mkdtemp(join(tmpdir(), "panda-file-publication-"));
const fixture = await createSiteBuildFixture({ workspaceDirectory: workspace });
const evidence = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.app.signIn(context);
      const api = async (path, data, method = data === undefined ? "get" : "post") => {
        const response = await context.request[method](fixture.app.base + path, {
          data,
          headers: { Origin: fixture.app.base },
        });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalogState = await api("/api/projects");
      const created = await api("/api/projects", {
        name: "File publishing",
        code: "file-links-" + width,
        revision: catalogState.revision,
      });
      const project = created.projects.find((p) => p.code === "file-links-" + width);
      const catalog = new ProjectCatalog(join(fixture.app.dir, "panda-state/data/projects.sqlite"));
      try {
        assert.equal(new ProjectDocumentStorage(catalog.db).files(project.id), true);
      } finally {
        catalog.close();
      }
      const tree = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: 0,
        title: "A file original",
        locale: "en",
        parentId: null,
      });
      const id = tree.operation.documentId;
      const scope = new URLSearchParams({ project: project.id, id });
      const opened = await api("/api/project-documents/editor?" + scope);
      const working = {
        ...opened.working,
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "The original saved body." }] }],
          },
        },
      };
      const draft = (
        await api(
          "/api/project-documents/editor?" + scope,
          {
            operationId: crypto.randomUUID(),
            version: opened.draft.version,
            baseRevisionId: opened.draft.baseRevisionId,
            working,
          },
          "put",
        )
      ).receipt;
      const checkpoint = await api("/api/project-documents/checkpoints?" + scope, {
        operationId: crypto.randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.version,
      });
      const page = await context.newPage(),
        errors = [],
        legacy = [],
        linkRequests = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          [
            "/api/documents/detail",
            "/api/document-spaces",
            "/api/document-spaces/source-profile",
            "/api/document-placements",
          ].includes(path)
        )
          legacy.push(path);
      });
      const openOriginal = async () => {
        await page.goto(fixture.app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator("#documentReadTitle").waitFor();
        await page.locator('[data-doc-action="publishing"]').click();
      };
      await openOriginal();
      const publishing = page.locator("#documentPublicationDialog");
      const form = page.locator("#documentPlacementDialog");
      await publishing.locator(".document-publication-empty").waitFor();
      assert.equal(await publishing.locator(".document-publication-channels").isVisible(), true);
      assert.equal(await publishing.locator('[data-placement-action="channels"]').isVisible(), true);
      assert.equal(await publishing.locator('[data-placement-action="spacing"]').isVisible(), true);
      await publishing.locator('[data-placement-action="new-space"]').click();
      await form.locator("#doc-name").fill("Website " + width);
      await form.locator("#doc-code").fill("website");
      await form.locator('[type="submit"]').click();
      await form.locator("#doc-link-space").waitFor();
      await form.locator("#doc-path").fill("posts/original.md");
      await form.locator("#doc-link-revision").selectOption(checkpoint.detail.revision.id);
      let dropped = false;
      await page.route(
        (url) => url.pathname === "/api/project-document-placements",
        async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          linkRequests.push(route.request().postDataJSON());
          if (!dropped) {
            dropped = true;
            const result = await route.fetch();
            assert.equal(result.status(), 201);
            return route.abort("failed");
          }
          return route.continue();
        },
      );
      await form.locator('[type="submit"]').click();
      await form.locator(".document-form-error").waitFor({ state: "visible" });
      await openOriginal();
      await publishing.locator("#placementRecoveryNotice").waitFor({ state: "visible" });
      assert.equal(await publishing.locator('[data-placement-action="new-space"]').isDisabled(), true);
      await publishing.locator('[data-placement-action="retry"]').click();
      await publishing.locator("#placementRecoveryNotice").waitFor({ state: "hidden" });
      await publishing.locator(".document-publication-card").waitFor();
      assert.equal(linkRequests.length, 2);
      assert.deepEqual(linkRequests[1], linkRequests[0]);
      let links = (
        await api("/api/project-document-placements?" + new URLSearchParams({ project: project.id, document: id }))
      ).placements;
      assert.equal(links.length, 1);
      const placement = links[0];
      const card = publishing.locator(`[data-placement-id="${placement.id}"]`);
      await card.locator('[data-placement-action="edit"]').click();
      await form.locator("#doc-path").fill("guides/pinned-original.md");
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      await card.locator('[data-placement-action="history"]').click();
      await form.locator(".placement-history li").nth(1).waitFor();
      assert.equal(await form.locator(".placement-history li").count(), 2);
      await form.locator('[type="submit"]').click();
      await card.locator('[data-placement-action="theme"]').click();
      const themes = (await api("/api/document-themes?engine=hexo")).themes;
      const theme = themes.find((value) => value.engine === "hexo");
      await form.locator("#doc-theme").selectOption(theme.id + "@" + theme.version);
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      fixture.hold();
      let releaseMetadata;
      let metadataReady;
      let metadataRequests = 0;
      const metadataHeld = new Promise((resolve) => {
        metadataReady = resolve;
      });
      const metadataReleased = new Promise((resolve) => {
        releaseMetadata = resolve;
      });
      await page.route(
        (url) =>
          url.pathname === "/api/project-document-spaces/detail" && url.searchParams.get("id") === placement.spaceId,
        async (route) => {
          if (route.request().method() !== "GET" || ++metadataRequests !== 1) return route.continue();
          const response = await route.fetch();
          metadataReady();
          await metadataReleased;
          await route.fulfill({ response });
        },
      );
      await card.locator('[data-placement-action="build"]').click();
      const build = page.locator("#siteBuildDialog");
      await metadataHeld;
      const previousConfiguration = await api(
        "/api/project-document-spaces/detail?" + new URLSearchParams({ project: project.id, id: placement.spaceId }),
      );
      const latestConfiguration = await api(
        "/api/project-document-spaces/detail?" + new URLSearchParams({ project: project.id, id: placement.spaceId }),
        {
          operationId: crypto.randomUUID(),
          version: previousConfiguration.space.version,
          name: "Latest website metadata",
        },
        "put",
      );
      await build.locator('[data-build-action="refresh"]').click();
      await waitFor(async () => build.locator("#createSiteBuild").isEnabled());
      releaseMetadata();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await build.locator("#build-url").fill("https://example.test");
      await waitFor(async () => build.locator("#createSiteBuild").isEnabled());
      await build.locator("#createSiteBuild").click();
      await waitFor(() => [...fixture.inputs.values()].some((value) => value.documents.some((doc) => doc.id === id)));
      const jobs = (
        await api("/api/site-builds?" + new URLSearchParams({ project: project.id, space: placement.spaceId }))
      ).builds;
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(job.projectId, project.id);
      assert.equal(job.sourceSnapshot.spaceVersion, latestConfiguration.space.version);
      assert.equal(metadataRequests, 2);
      assert.match(job.sourceSnapshot.commit, /^[a-f0-9]{40}$/);
      assert.equal(job.sources[0].revisionId, checkpoint.detail.revision.id);
      const captured = fixture.inputs.get(job.id);
      assert.match(captured.documents[0].content, /The original saved body/);
      assert.equal(captured.documents[0].path, "guides/pinned-original.md");
      const newer = await api("/api/project-documents/editor?" + scope);
      await api(
        "/api/project-documents/editor?" + scope,
        {
          operationId: crypto.randomUUID(),
          version: newer.draft.version,
          baseRevisionId: newer.draft.baseRevisionId,
          working: { ...newer.working, title: "A newer draft during the build" },
        },
        "put",
      );
      fixture.finish();
      await build.locator('[data-build-action="download"]').waitFor();
      assert.equal(await build.locator('[data-build-action="publish"]').isVisible(), true);
      await build.locator('[data-build-action="preview"]').click();
      await build.frameLocator("iframe").locator("h1").waitFor();
      assert.equal(await page.evaluate(() => window.__unsafeBuild), undefined);
      const downloaded = page.waitForEvent("download");
      await build.locator('[data-build-action="download"]').click();
      assert.equal((await downloaded).suggestedFilename(), `site-${job.id}.zip`);
      await build.locator('[data-build-action="publish"]').click();
      const delivery = page.locator("#sitePublicationDialog");
      await delivery.locator('[data-delivery-action="connections"]').click();
      assert.equal(await delivery.locator('[data-delivery-action="accounts"]').isHidden(), true);
      await delivery.locator("#publish-name").fill("File destination " + width);
      await delivery.locator("#publish-directory").fill("file-website-" + width);
      await delivery.locator("#publish-url").fill("https://example.test/");
      await delivery.locator('#publicationConnectionForm [type="submit"]').click();
      await delivery.locator("[data-connection-test]").waitFor();
      const roots = (await api("/api/publication-connections/roots")).roots;
      assert.equal((await readdir(roots[0].path)).includes("file-website-" + width), false);
      await delivery.locator('[data-delivery-action="history"]').click();
      await delivery.locator('[data-delivery-action="prepare"]').click();
      await delivery.locator('.delivery-phase[data-phase="prepared"]').waitFor();
      const publicationQuery = new URLSearchParams({ space: placement.spaceId, project: project.id });
      const prepared = (await api("/api/site-publications?" + publicationQuery)).publications[0];
      assert.equal(prepared.plan.sourceProjectId, project.id);
      assert.deepEqual(prepared.plan.build.sourceSnapshot, job.sourceSnapshot);
      assert.deepEqual(prepared.plan.build.sources, job.sources);
      assert.ok((await delivery.locator("#deliveryPlan").textContent()).includes(job.sourceSnapshot.commit));
      assert.equal(
        (await context.request.get(fixture.app.base + "/api/site-publications?space=" + placement.spaceId)).status(),
        404,
      );
      assert.equal(await delivery.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      let lostPublishReply = false;
      await page.route(
        (url) => url.pathname === "/api/site-publications/publish",
        async (route) => {
          if (!lostPublishReply) {
            lostPublishReply = true;
            const response = await route.fetch();
            assert.equal(response.status(), 202);
            return route.abort("failed");
          }
          return route.continue();
        },
      );
      await delivery.locator('[data-delivery-action="publish"]').click();
      await delivery.locator("#deliveryNotice").waitFor({ state: "visible" });
      await delivery.locator('[data-delivery-action="refresh"]').click();
      await delivery.locator('.delivery-phase[data-phase="published"]').waitFor();
      const published = (await api("/api/site-publications?" + publicationQuery)).publications[0];
      const replay = await api("/api/site-publications/publish", {
        id: prepared.plan.id,
        fingerprint: prepared.plan.fingerprint,
      });
      assert.deepEqual(replay.publication.job.receipt, published.job.receipt);
      assert.deepEqual(published.plan, prepared.plan);
      const target = join(roots[0].path, "file-website-" + width);
      assert.deepEqual(await readdir(join(target, "releases")), [prepared.plan.id]);
      assert.match(await readFile(join(target, "current/index.html"), "utf8"), /Fixture website/);
      await page.screenshot({ path: `.artifacts/file-publication-${width}-receipt.png` });
      await delivery.locator('[data-delivery-action="close"]').click();
      await build.locator('[data-build-action="publish"]').click();
      await delivery.locator('.delivery-phase[data-phase="published"]').waitFor();
      await delivery.locator('[data-delivery-action="close"]').click();
      await build.locator('[data-build-action="close"]').click();
      await api("/api/site-builds/detail?id=" + job.id, undefined, "delete");
      await card.locator('[data-placement-action="delivery"]').click();
      await delivery.locator('[data-delivery-action="history"]').click();
      await delivery.locator('.delivery-phase[data-phase="published"]').waitFor();
      assert.equal(await delivery.locator('[data-delivery-action="accounts"]').isHidden(), true);
      assert.ok((await delivery.locator("#deliveryPlan").textContent()).includes(job.sourceSnapshot.commit));
      await delivery.locator('[data-delivery-action="close"]').click();
      const sourceRoot = join(workspace, "source-" + width);
      await mkdir(join(sourceRoot, "source-en/_posts"), { recursive: true });
      await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ dependencies: { hexo: "8.1.1" } }));
      const configuration =
        "title: A public source\nurl: https://example.test\ndeploy:\n  password: never-publish-this-fixture-value\n";
      await writeFile(join(sourceRoot, "_config.base.yml"), configuration);
      await writeFile(join(sourceRoot, "_config.en.yml"), "root: /journal/\nblog_language: en\n");
      await publishing.locator('[data-placement-action="new-space"]').click();
      await form.locator("#doc-name").fill("External source");
      await form.locator("#doc-code").fill("external-source");
      await form.locator("#doc-sourceMode").selectOption("external");
      await form.locator("#doc-sourceRoot").fill("/outside-publication-test");
      await form.locator('[type="submit"]').click();
      await form.locator(".document-form-error").waitFor({ state: "visible" });
      await form.locator("#doc-sourceRoot").fill(sourceRoot);
      await form.locator('[type="submit"]').click();
      await form.locator("#doc-link-space").waitFor();
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      const externalCard = publishing.locator(".document-publication-card").filter({ hasText: "External source" });
      await externalCard.locator('[data-placement-action="source-profile"]').click();
      await form.locator('[name="document-config-0"]').check();
      await form.locator('[name="document-config-1"]').check();
      await form.locator('[type="submit"]').click();
      const profile = JSON.parse(await form.locator("#doc-profile").inputValue());
      assert.equal(profile.editions.en.basePath, "/journal/");
      assert.doesNotMatch(JSON.stringify(profile), /never-publish|password/);
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      links = (
        await api("/api/project-document-placements?" + new URLSearchParams({ project: project.id, document: id }))
      ).placements;
      assert.equal(links.length, 2);
      const externalSpace = (
        await api("/api/project-document-spaces?" + new URLSearchParams({ project: project.id }))
      ).spaces.find((value) => value.code === "external-source");
      const savedProfile = await api(
        "/api/project-document-spaces/detail?" + new URLSearchParams({ project: project.id, id: externalSpace.id }),
      );
      assert.equal(savedProfile.profile.editions.en.basePath, "/journal/");
      assert.equal(await readFile(join(sourceRoot, "_config.base.yml"), "utf8"), configuration);
      await externalCard.locator('[data-placement-action="remove"]').click();
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      assert.equal(
        (await api("/api/project-document-placements?" + new URLSearchParams({ project: project.id, document: id })))
          .placements.length,
        1,
      );
      assert.equal(
        (await api("/api/project-documents/editor?" + scope)).working.title,
        "A newer draft during the build",
      );
      assert.deepEqual(legacy, []);
      assert.deepEqual(errors, []);
      assert.equal(await publishing.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      evidence.push({
        width,
        locale,
        persistedRetry: true,
        projectScopedBuild: true,
        pinnedSource: true,
        sourceConfiguration: true,
        originalAndDraftPreserved: true,
        noLegacyRequests: true,
      });
    } finally {
      await browser.close();
    }
  }
  await mkdir(".artifacts/file-publication-browser", { recursive: true });
  await writeFile(".artifacts/file-publication-browser/verified.json", JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await fixture.dispose();
  await rm(workspace, { recursive: true, force: true });
}
