import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
const artifacts = ".artifacts/publication-variants";
await mkdir(artifacts, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return fixture.legacyProject(data);
        const response = await context.request[method](fixture.base + path, { data });
        assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const projects = await api("/api/projects", {
        code: "publish-" + width,
        name: "Writing studio",
        revision: catalog.revision,
      });
      const project = projects.projects.find((p) => p.code === "publish-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "writing",
        name: "Writing",
        engine: "markdown",
        sourceMode: "managed",
        locale: "en",
        theme: "default",
      });
      const source =
        "Two  spaces.\n\n" +
        "A paragraph about reliable publishing. ".repeat(35) +
        "\n\n> Attribution and quotation remain intact.\n\n```js\nconst  example = 1;\n```";
      const document = await api("/api/documents", {
        spaceId: space.id,
        path: "article.md",
        title: "A thoughtful release",
        locale: "en",
        content: source,
      });
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(12_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator('[data-doc-action="publishing"]').click();
      await page.locator("#publicationFormat").selectOption("x-post");
      await page.locator('[data-pub-action="prepare"]').click();
      await page.locator('.publishing-post [data-invalid="true"]').waitFor();
      assert.equal(await page.locator('[data-pub-action="review"]').isDisabled(), true);
      if (width === 390) await page.locator('[data-pub-action="settings"]').click();
      await page.locator("#publicationFormat").selectOption("x-thread");
      await page.locator('[data-pub-action="prepare"]').click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".publishing-post").length > 1 &&
          !document.querySelector('[data-pub-action="prepare"]').disabled,
      );
      assert.equal(await page.locator('.publishing-post [data-invalid="true"]').count(), 0);
      await page.locator('[data-pub-action="review"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-pub-action="review"]').disabled &&
          !document.querySelector('[data-pub-action="prepare"]').disabled,
      );
      const download = page.waitForEvent("download");
      await page.locator('[data-pub-action="export-text"]').click();
      assert.match((await download).suggestedFilename(), /\.txt$/);
      if (width === 390) await page.locator('[data-pub-action="settings"]').click();
      await page.locator('[data-pub-action="proofread"]').click();
      await page.locator("[data-suggestion]").first().check();
      await page.locator('[data-pub-action="apply-suggestions"]').click();
      await page.locator("#publishingDialog").waitFor({ state: "hidden" });
      const draft = await page.locator("#documentSource").inputValue();
      assert.ok(draft.includes("Two spaces."));
      assert.ok(draft.includes("const  example"));
      const saved = await api("/api/documents/detail?id=" + document.document.id, undefined, "get");
      assert.equal(saved.revision.content, source, "Proofreading must not write the source automatically");
      assert.equal(await page.locator('[data-doc-action="publishing"]').isDisabled(), true);
      await page.locator('[data-doc-action="save"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-doc-action="publishing"]').disabled);
      await page.locator('[data-doc-action="publishing"]').click();
      await page.waitForFunction(() => document.querySelector("#publicationHistory").options.length > 1);
      const old = await page.locator("#publicationHistory option").nth(1).getAttribute("value");
      await page.locator("#publicationHistory").selectOption(old);
      await page.locator('#publicationVersionState[data-stale="true"]').waitFor();
      assert.equal(await page.locator('[data-pub-action="review"]').isDisabled(), true);
      if (width === 390) await page.locator('[data-pub-action="settings"]').click();
      await page.locator("#publicationFormat").selectOption("x-article");
      await page.locator('[data-pub-action="prepare"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector("#publicationVersionState").dataset.stale === "false" &&
          !document.querySelector('[data-pub-action="prepare"]').disabled,
      );
      assert.ok((await page.locator("#publicationPreview").innerText()).includes("const  example"));
      assert.doesNotMatch(await page.locator("#publishingDialog").innerText(), /publishing\.[a-zA-Z]+/);
      for (const viewport of width === 390 ? [320, 390, 768] : [1440]) {
        await page.setViewportSize({ width: viewport, height: 960 });
        assert.ok(await page.locator("#publishingDialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
        const rect = await page.locator('[data-pub-action="close"]').boundingBox();
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= viewport + 1);
      }
      await page.setViewportSize({ width, height: 960 });
      await page.screenshot({ path: `${artifacts}/review-${engine.name()}.png` });
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()}: formats, explicit review, exports, proofreading, stale revisions and responsive dialog passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
