import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppFixture } from "../support/app-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "panda-image-browser-"));
const fixture = await createAppFixture({ workspaceDirectory: root });
const png = (background) =>
  sharp({ create: { width: 48, height: 36, channels: 3, background } })
    .png()
    .toBuffer();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 920 }, locale });
      await fixture.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return fixture.legacyProject(data);
        const response = await context.request[method](fixture.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const source = join(root, "blog-" + width);
      await mkdir(join(source, "source-en/_posts"), { recursive: true });
      await mkdir(join(source, "assets"));
      await writeFile(join(source, "package.json"), JSON.stringify({ dependencies: { hexo: "8.1.1" } }));
      const content =
        '{% abstract "Overview" %}\nRead-only **source**.\n{% endabstract %}\n\n{% figure "/assets/diagram.png" "Diagram" %}\nA clear caption.\n{% endfigure %}\n\n![Remote](https://example.invalid/no-request.png)\n\n<script>window.ingestionXss=true</script>';
      await writeFile(join(source, "source-en/_posts/article.md"), content);
      await writeFile(join(source, "assets/diagram.png"), await png("red"));
      const catalog = await api("/api/projects", undefined, "get");
      const projects = await api("/api/projects", {
        name: "Image ingestion",
        code: "images-" + width,
        revision: catalog.revision,
      });
      const project = projects.projects.find((value) => value.code === "images-" + width);
      await api("/api/document-spaces", {
        projectId: project.id,
        code: "blog",
        name: "Blog",
        engine: "hexo",
        sourceMode: "external",
        sourceRoot: source,
        locale: "en",
      });
      const page = await context.newPage();
      const errors = [],
        externalImages = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().includes("example.invalid")) externalImages.push(request.url());
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator('[data-doc-action="scan"]').click();
      await page.locator(".document-import-issues").waitFor();
      assert.match(await page.locator(".document-import-issues").innerText(), /no-request.png/);
      assert.doesNotMatch(await page.locator("#documentDialog").innerText(), /documents\.image/);
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator(".document-file").click();
      assert.equal(await page.locator("#documentSource").inputValue(), content);
      const importButton = page.locator('[data-doc-action="import-images"]');
      assert.equal(await importButton.isEnabled(), true);
      await page.locator('[data-doc-action="preview"]').click();
      await page.waitForFunction(() => document.querySelector("#documentPreview figure img")?.naturalWidth === 48);
      assert.equal(await page.locator("#documentPreview figcaption").innerText(), "A clear caption.");
      assert.equal(await page.locator("#documentPreview .document-abstract strong").innerText(), "source");
      assert.equal(await page.evaluate(() => Boolean(window.ingestionXss)), false);
      const originalImage = await page.locator("#documentPreview figure img").getAttribute("src");
      await page.locator('[data-doc-action="edit"]').click();
      await writeFile(join(source, "assets/diagram.png"), await png("blue"));
      let release;
      const hold = new Promise((resolve) => {
        release = resolve;
      });
      let observed;
      const started = new Promise((resolve) => {
        observed = resolve;
      });
      await page.route("**/api/documents/import-assets", async (route) => {
        const response = await route.fetch();
        observed();
        await hold;
        await route.fulfill({ response });
      });
      await importButton.click();
      await started;
      await page.locator("#documentSource").fill(content + "\nDraft typed during import");
      release();
      await page.locator(".document-import-issues").waitFor();
      await page.locator('#documentDialog [type="submit"]').click();
      await page.unroute("**/api/documents/import-assets");
      assert.equal(await page.locator("#documentSource").inputValue(), content + "\nDraft typed during import");
      assert.equal(await importButton.isDisabled(), true);
      await page.locator('[data-doc-action="preview"]').click();
      assert.notEqual(await page.locator("#documentPreview figure img").getAttribute("src"), originalImage);
      await page.locator('[data-doc-action="history"]').click();
      await page.locator("#documentRevisionSelect").waitFor();
      const revisions = await page
        .locator("#documentRevisionSelect option")
        .evaluateAll((options) => options.map((option) => option.value));
      await page.locator("#documentRevisionSelect").selectOption(revisions.at(-1));
      await page.locator('#documentDialog [type="submit"]').click();
      await page.waitForFunction(() => /3/.test(document.querySelector(".document-revision")?.textContent || ""));
      await page.locator('[data-doc-action="preview"]').click();
      assert.equal(await page.locator("#documentPreview figure img").getAttribute("src"), originalImage);
      assert.equal(await page.locator("#documentSource").inputValue(), content);
      assert.deepEqual(externalImages, []);
      assert.deepEqual(errors, []);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false);
      await mkdir(".artifacts/document-ingestion", { recursive: true });
      await page.screenshot({ path: `.artifacts/document-ingestion/${engine.name()}-${width}.png` });
      console.log(
        `${engine.name()} ${width}: source images, semantic preview, issue report, in-flight draft and historical image restoration passed`,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
  await rm(root, { recursive: true, force: true });
}
