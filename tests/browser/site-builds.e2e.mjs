import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";

const fixture = await createSiteBuildFixture(),
  app = fixture.app;
await mkdir(".artifacts/site-builds-browser", { recursive: true });
try {
  for (const [browserEngine, width, locale, buildEngine] of [
    [chromium, 1440, "en", "hexo"],
    [webkit, 390, "zh-CN", "docusaurus"],
  ]) {
    const browser = await browserEngine.launch({
      headless: true,
      ...(browserEngine === chromium ? { args: ["--no-sandbox"] } : {}),
    });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const projects = await api("/api/projects", {
        code: "build-" + width,
        name: "Writing studio",
        revision: catalog.revision,
      });
      const project = projects.projects.find((value) => value.code === "build-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "docs",
        name: "Product handbook",
        engine: buildEngine,
        sourceMode: "managed",
        locale: "en",
      });
      await api("/api/documents", {
        spaceId: space.id,
        path: "welcome.md",
        title: "Welcome",
        locale: "en",
        content: "Saved revision before build.",
      });
      const page = await context.newPage(),
        errors = [],
        unexpected = [];
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().includes("untrusted.example")) unexpected.push(request.url());
      });
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Keep this unsaved draft.");
      await page.locator('[data-doc-action="build"]').click();
      assert.equal(
        await page.locator("#siteBuildDialog").evaluate((element) => getComputedStyle(element).display),
        "flex",
      );
      await page.waitForFunction(() => !document.querySelector("#createSiteBuild").disabled);
      assert.equal(await page.locator("#build-engine").inputValue(), buildEngine);
      await page.locator("#build-basePath").fill("/handbook/");
      await page.locator("#createSiteBuild").click();
      try {
        await page.locator('[data-build-action="download"]').waitFor();
      } catch (error) {
        console.error({
          view: await page.locator("#siteBuildDialog").textContent(),
          errors,
          starts: fixture.starts,
          states: [...fixture.jobs.values()],
        });
        await page.screenshot({ path: `.artifacts/site-builds-browser/${width}-failed.png` });
        throw error;
      }
      assert.equal(
        await page
          .locator("#siteBuildDialog")
          .textContent()
          .then((text) => /builds\.[a-zA-Z]/.test(text)),
        false,
      );
      await page.locator('[data-build-action="preview"]').click();
      const preview = page.frameLocator("#buildPreviewMount iframe");
      await preview.locator("h1").waitFor();
      assert.equal(await preview.locator("h1").textContent(), "Fixture website");
      assert.equal(
        await preview.locator("h1").evaluate((element) => getComputedStyle(element).color),
        "rgb(42, 63, 84)",
      );
      assert.equal(
        await preview
          .locator("img")
          .first()
          .evaluate((image) => image.complete && image.naturalWidth === 12),
        true,
      );
      assert.equal(await page.evaluate(() => globalThis.__unsafeBuild), undefined);
      assert.deepEqual(unexpected, []);
      await page.locator("#buildPreviewMount select").selectOption("about/index.html");
      await preview.getByRole("heading", { name: "About fixture" }).waitFor();
      assert.equal(await preview.locator("h1").textContent(), "About fixture");
      const download = page.waitForEvent("download");
      await page.locator('[data-build-action="download"]').click();
      assert.match((await download).suggestedFilename(), /^site-[a-f0-9-]+\.zip$/);
      await page.locator('[data-build-action="snapshot"]').click();
      assert.match(await page.locator("#buildSnapshotPane").textContent(), /welcome\.md/);
      await page.screenshot({ path: `.artifacts/site-builds-browser/${width}-${locale}.png` });
      for (const size of [width, 320]) {
        await page.setViewportSize({ width: size, height: 900 });
        assert.ok(
          await page.locator("#siteBuildDialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 2),
        );
        assert.ok(await page.locator('[data-build-action="close"]').isVisible());
      }
      await page.locator('[data-build-action="close"]').click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Keep this unsaved draft.");
      await page.locator('[data-doc-action="build"]').click();
      await page.locator('[data-build-action="download"]').waitFor();
      fixture.hold();
      await page.locator(".builds-settings").evaluate((element) => {
        element.open = true;
      });
      await page.locator("#createSiteBuild").click();
      await page.locator('[data-build-action="cancel"]').waitFor();
      await page.locator('[data-build-action="cancel"]').click();
      await page.locator('.builds-summary [data-phase="cancelled"]').waitFor();
      await page.locator('[data-build-action="delete"]').click();
      await page.locator('[data-build-action="confirm-delete"]').click();
      await page.locator('[data-build-action="download"]').waitFor();
      fixture.finish();
      await page.locator('[data-build-action="close"]').click();
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Site builds: saved revisions, desktop/mobile controls, sandboxed preview, download, cancel and history passed.",
  );
} finally {
  await fixture.dispose();
}
