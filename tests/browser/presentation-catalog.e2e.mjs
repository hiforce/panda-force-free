import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { waitFor } from "../support/app-fixture.mjs";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";

const fixture = await createSiteBuildFixture();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const response = await context.request[method](fixture.app.base + path, { data });
        assert.ok(response.ok(), path + ": " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const created = await api("/api/projects", {
        name: "Theme selection",
        code: "themes-" + width,
        revision: catalog.revision,
      });
      const project = created.projects.find((item) => item.code === "themes-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "blog",
        name: "Theme studio",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      });
      const document = await api("/api/documents", {
        spaceId: space.id,
        path: "article.md",
        title: "Article",
        locale: "en",
        content: "A saved source.",
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Unsaved typing survives a theme change.");
      await page.locator('[data-doc-action="theme"]').click();
      await page.locator("#doc-theme").selectOption("panda.journal@1.0.0");
      assert.doesNotMatch(await page.locator("#documentDialog").innerText(), /documents\.theme/);
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator("#documentDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsaved typing survives a theme change.");
      await page.locator('[data-doc-action="build"]').click();
      await page.waitForFunction(() => document.querySelector("#createSiteBuild")?.disabled === false);
      assert.match(await page.locator("#buildPreset").innerText(), /1\.0\.0/);
      await page.locator("#build-engine").selectOption("docusaurus");
      assert.equal(await page.locator("#createSiteBuild").isDisabled(), true);
      await page.locator("#build-engine").selectOption("hexo");
      await page.locator("#createSiteBuild").click();
      await page.locator('[data-build-action="snapshot"]').waitFor();
      await page.locator('[data-build-action="snapshot"]').click();
      assert.match(await page.locator("#buildSnapshotPane").innerText(), /panda\.journal/);
      const jobs = (await api("/api/site-builds?space=" + space.id, undefined, "get")).builds,
        previous = jobs[0];
      assert.equal(previous.theme.id, "panda.journal");
      await waitFor(() => fixture.inputs.has(previous.id));
      const oldInput = JSON.stringify(fixture.inputs.get(previous.id));
      await page.locator('[data-build-action="close"]').click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsaved typing survives a theme change.");
      await page.locator('[data-doc-action="theme"]').click();
      await page.locator("#doc-theme").selectOption("panda.reader@1.0.0");
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator("#documentDialog").waitFor({ state: "hidden" });
      assert.equal(
        (await api("/api/site-builds/detail?id=" + previous.id, undefined, "get")).build.theme.id,
        "panda.journal",
      );
      assert.equal(JSON.stringify(fixture.inputs.get(previous.id)), oldInput);
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsaved typing survives a theme change.");
      await page.locator('[data-doc-action="theme"]').click();
      assert.equal(await page.locator("#doc-theme").inputValue(), "panda.reader@1.0.0");
      await page.locator("#documentDialog [data-doc-close]").click();
      await page.locator("#documentSource").fill("A saved source.");
      await page.locator('[data-doc-action="publishing"]').click();
      await page.locator('#publicationTemplate option[value="technical@1"]').waitFor({ state: "attached" });
      await page.locator("#publicationTemplate").selectOption("technical@1");
      await page.locator('[data-pub-action="prepare"]').click();
      await page.locator("#publicationPreview article").waitFor();
      const variants = (await api("/api/publication-variants?document=" + document.document.id, undefined, "get"))
        .variants;
      const detail = await api("/api/publication-variants/detail?id=" + variants[0].id, undefined, "get");
      assert.equal(detail.variant.templateVersion, "1");
      assert.equal(detail.variant.templateSnapshot.id, "technical");
      assert.match(detail.variant.templateDigest, /^[a-f0-9]{64}$/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `${engine.name()} ${width}: theme selection, draft preservation, compatibility, frozen build history and versioned channel templates passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
