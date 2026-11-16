import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { nativeFiles, nativeSettings, nativeZipSource } from "../support/native-theme.js";

const workspace = await mkdtemp(join(tmpdir(), "panda-native-project-browser-")),
  executor = await createSampleExecutorHttp({ native: true }),
  app = await createAppFixture({
    workspaceDirectory: workspace,
    extraEnvironment({ dir }) {
      const token = join(dir, "native-token");
      writeFileSync(token, executor.token, { mode: 0o600 });
      return { PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url, PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: token };
    },
  }),
  artifacts = ".artifacts/native-project-builds";
await mkdir(artifacts, { recursive: true });
try {
  for (const [browserType, width, locale, engine] of [
    [chromium, 1440, "en", "hexo"],
    [webkit, 390, "zh-CN", "docusaurus"],
  ]) {
    const browser = await browserType.launch({
      headless: true,
      ...(browserType === chromium ? { args: ["--no-sandbox"] } : {}),
    });
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 500 ? "dark" : "light",
      });
      await app.signIn(context);
      async function api(path, data, method = data === undefined ? "get" : "post") {
        const response = await context.request[method](app.base + path, {
          ...(data === undefined ? {} : { data: data instanceof Uint8Array ? Buffer.from(data) : data }),
          ...(data instanceof Uint8Array ? { headers: { "content-type": "application/octet-stream" } } : {}),
        });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      }
      const zip = await nativeZipSource({
          ...nativeFiles,
          "theme/index.js": "module.exports=()=>({name:'project-fixture'});",
        }),
        source = await api("/api/package-sources", {
          purpose: "templates",
          operationId: randomUUID(),
          request: {
            source: {
              kind: "zip-upload",
              name: "project-theme.zip",
              bytes: zip.bytes.length,
              sha256: createHash("sha256").update(zip.bytes).digest("hex"),
            },
          },
        });
      await api(
        "/api/package-sources/upload?" +
          new URLSearchParams({ purpose: "templates", id: source.id, revision: String(source.revision) }),
        zip.bytes,
      );
      const ready = await waitFor(async () => {
          const value = await api("/api/package-sources/task?purpose=templates&id=" + source.id);
          if (value.state === "failed") throw Error(value.failure);
          return value.state === "ready" && value;
        }),
        themeId = "example.project-ui-" + width,
        definition = {
          source: { id: ready.id, sha256: ready.digest, root: "theme" },
          settings: { ...nativeSettings(), id: themeId, engine, entry: engine === "hexo" ? null : "index.js" },
        },
        review = await api("/api/templates/native/review", definition),
        installed = await api("/api/templates/native/install", {
          ...definition,
          approval: {
            operationId: randomUUID(),
            expectedRevision: review.revision,
            reviewHash: review.reviewHash,
            permissions: ["build:theme-code"],
            licenseAcknowledged: true,
          },
        }),
        theme = installed.current.themes.find((value) => value.id === themeId),
        themeRef = { id: theme.id, version: theme.version, digest: theme.digest },
        catalog = await api("/api/projects"),
        created = await api("/api/projects", {
          name: "Native project",
          code: "native-ui-" + width,
          revision: catalog.revision,
        }),
        project = created.projects.find((value) => value.code === "native-ui-" + width),
        tree = await api("/api/project-document-tree/documents", {
          id: randomUUID(),
          projectId: project.id,
          treeVersion: 0,
          title: "Native project original",
          locale: "en",
          parentId: null,
        }),
        id = tree.operation.documentId,
        scope = new URLSearchParams({ project: project.id, id }),
        original = await api("/api/project-documents/editor?" + scope),
        working = {
          ...original.working,
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Native project original saved content", marks: [{ type: "bold" }] }],
                },
              ],
            },
          },
        },
        draft = (
          await api(
            "/api/project-documents/editor?" + scope,
            {
              operationId: randomUUID(),
              version: original.draft.version,
              baseRevisionId: original.draft.baseRevisionId,
              working,
            },
            "put",
          )
        ).receipt,
        saved = await api("/api/project-documents/checkpoints?" + scope, {
          operationId: randomUUID(),
          revisionId: original.saved.revision.id,
          draftVersion: draft.version,
        }),
        { space } = await api("/api/project-document-spaces", {
          operationId: randomUUID(),
          projectId: project.id,
          code: "site",
          name: "Native website",
          engine,
          sourceMode: "managed",
          locale: "en",
          theme: "default",
        }),
        { placement } = await api("/api/project-document-placements?project=" + project.id, {
          operationId: randomUUID(),
          id: randomUUID(),
          documentId: id,
          spaceId: space.id,
          spaceVersion: space.version,
          path: "article.md",
          locale: "en",
          revisionId: saved.detail.revision.id,
          metadata: {},
        });
      page = await context.newPage();
      const errors = [],
        external = [],
        posted = [];
      let drop = true;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
      });
      await page.route("**/api/site-builds", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posted.push(route.request().postDataJSON());
        if (!drop) return route.continue();
        drop = false;
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 202);
        await route.abort("failed");
      });
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      await page.locator('[data-doc-action="publishing"]').click();
      await page.locator(`[data-placement-id="${placement.id}"] [data-placement-action="build"]`).click();
      const build = page.locator("#siteBuildDialog"),
        picker = page.locator("#buildThemePicker");
      await build.locator("#createSiteBuild:enabled").waitFor();
      await build.locator('[data-build-action="theme"]').click();
      await picker.locator("#buildThemeSearch").fill("project-ui");
      await picker.locator(`[data-build-theme="${themeId}@1.0.0"]`).click();
      const monitor = picker.locator(".site-sample-monitor");
      await monitor.locator('[data-sample-action="start"]:enabled').click();
      await waitFor(() => executor.gates.size > 0);
      const sample = [...executor.gates.keys()][0];
      executor.release(sample);
      await monitor.locator('iframe[srcdoc*="#123456"]').waitFor();
      assert.equal(await picker.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      await page.screenshot({ path: `${artifacts}/picker-${width}.png` });
      await picker.locator('button[type="submit"]').click();
      await picker.waitFor({ state: "hidden" });
      assert.match(await build.locator("#buildPreset").textContent(), /Native theme/);
      await build.locator("#createSiteBuild:enabled").click();
      await build.locator("#createSiteBuild:enabled").waitFor();
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0].nativeTheme, themeRef);
      await build.locator("#createSiteBuild").click();
      assert.equal(posted.length, 2);
      assert.deepEqual(posted[0], posted[1]);
      await waitFor(() => executor.gates.has(posted[0].id));
      const jobId = posted[0].id;
      assert.ok(executor.inputs.get(jobId).documents[0].content.includes("Native project original saved content"));
      executor.release(jobId);
      await build.locator('[data-build-action="download"]').waitFor();
      await build.locator('[data-build-action="snapshot"]').click();
      assert.ok((await build.locator("#buildSnapshotPane").innerText()).includes(themeId));
      assert.ok((await build.locator("#buildSnapshotPane").innerText()).includes(theme.digest));
      await build.locator('[data-build-action="preview"]').click();
      await build.frameLocator("iframe").locator("h1").waitFor();
      const download = page.waitForEvent("download");
      await build.locator('[data-build-action="download"]').click();
      assert.equal((await download).suggestedFilename(), `site-${jobId}.zip`);
      await build.locator('[data-build-action="publish"]').click();
      const delivery = page.locator("#sitePublicationDialog");
      await delivery.locator('[data-delivery-action="connections"]').click();
      await delivery.locator("#publish-name").fill("Native destination");
      await delivery.locator("#publish-directory").fill("native-output-" + width);
      await delivery.locator("#publish-url").fill("https://example.com/");
      await delivery.locator('#publicationConnectionForm [type="submit"]').click();
      await delivery.locator("[data-connection-test]").waitFor();
      await delivery.locator('[data-delivery-action="history"]').click();
      await delivery.locator('[data-delivery-action="prepare"]').click();
      await delivery.locator('.delivery-phase[data-phase="prepared"]').waitFor();
      const plans = (
          await api("/api/site-publications?" + new URLSearchParams({ space: space.id, project: project.id }))
        ).publications,
        plan = plans.find((value) => value.plan.build.id === jobId);
      assert.equal(plan.plan.build.inputHash, (await api("/api/site-builds/detail?id=" + jobId)).build.inputHash);
      assert.equal(plan.plan.sourceProjectId, project.id);
      assert.equal(plan.job.phase, "prepared");
      const roots = (await api("/api/publication-connections/roots")).roots;
      const output = (await import("node:fs")).existsSync(join(roots[0].path, "native-output-" + width));
      assert.equal(output, false);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.doesNotMatch(await picker.textContent(), /builds\.chooseTheme|builds\.themeChoiceHint/);
      await page.screenshot({ path: `${artifacts}/prepared-${width}.png` });
      await context.close();
      console.log(
        `${browserType.name()} ${width}: native card selection, sample preview, fixed project build retry, private output and owner-bound publication plan passed without activation`,
      );
    } catch (error) {
      if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
  await executor.stop();
  await rm(workspace, { recursive: true, force: true });
}
