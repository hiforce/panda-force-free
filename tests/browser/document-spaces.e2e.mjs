import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createAppFixture } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
const artifacts = ".artifacts/document-spaces";
await mkdir(artifacts, { recursive: true });
const checks = [];
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
        const res = await context.request[method](fixture.base + path, { data });
        assert.ok(res.ok(), `${method} ${path}: ${res.status()}`);
        return res.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const created = await api("/api/projects", {
        name: "Publishing studio",
        code: "docs-" + width,
        revision: catalog.revision,
      });
      const project = created.projects.find((p) => p.code === "docs-" + width);
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.base + "/project?id=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator('[data-route^="/documents?project="]').click();
      await openConnectedDocumentSources(page);
      await page.locator('[data-doc-action="new-space"]').click();
      await page.locator("#doc-name").fill("Product handbook");
      await page.locator("#doc-code").fill("handbook");
      await page.locator('#documentDialog [type="submit"]').click();
      await page
        .locator("#documentDialog")
        .waitFor({ state: "hidden" })
        .catch(async (error) => {
          console.error(await page.locator("#documentDialog").innerText());
          console.error(
            await page.locator("#documentDialog input").evaluateAll((inputs) =>
              inputs.map((input) => ({
                id: input.id,
                value: input.value,
                valid: input.validity.valid,
                message: input.validationMessage,
              })),
            ),
          );
          await page.screenshot({ path: artifacts + "/failure.png" });
          throw error;
        });
      await page.locator('[data-doc-action="new-document"]').click();
      await page.locator("#doc-title").fill("Getting started");
      await page.locator("#doc-path").fill("guides/getting-started.md");
      await page.locator('#documentDialog [type="submit"]').click();
      await page
        .locator("#documentDialog")
        .waitFor({ state: "hidden" })
        .catch(async (error) => {
          console.error(await page.locator("#documentDialog").innerText());
          console.error(
            await page.locator("#documentDialog input").evaluateAll((inputs) =>
              inputs.map((input) => ({
                id: input.id,
                value: input.value,
                valid: input.validity.valid,
                message: input.validationMessage,
              })),
            ),
          );
          await page.screenshot({ path: artifacts + "/failure.png" });
          throw error;
        });
      const content =
        '# A clear source\n\nText with **emphasis**.\n\n<script>window.documentXss=true</script>\n\n<button data-doc-action="save">Injected control</button>\n\n```js\nconsole.log("hello");\n```';
      await page.locator("#documentSource").fill(content);
      await page.locator('[data-doc-action="save"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-doc-action="save"]')?.disabled &&
          /2/.test(document.querySelector(".document-revision")?.textContent || ""),
      );
      await page.locator('[data-doc-action="preview"]').click();
      assert.equal(
        await page
          .locator("#documentPreview script, #documentPreview button, #documentPreview [data-doc-action]")
          .count(),
        0,
      );
      assert.equal(await page.evaluate(() => Boolean(window.documentXss)), false);
      assert.match(await page.locator("#documentPreview").innerText(), /Injected control/);
      assert.equal(await page.locator("#documentPreview strong").innerText(), "emphasis");
      await page.locator('[data-doc-action="edit"]').click();
      await page.locator("#documentSource").fill("# Unsaved recovery");
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      assert.equal(await page.locator("#documentSource").inputValue(), "# Unsaved recovery");
      checks.push(
        `${engine.name()} ${width}: create space/draft, save revision, safe preview and recovery after reload`,
      );
      const peerPage = await context.newPage();
      await peerPage.goto(page.url());
      await peerPage.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(peerPage);
      await peerPage.locator(".document-file").click();
      assert.equal(await peerPage.locator("#documentSource").inputValue(), content);
      await peerPage.locator("#documentSource").fill("# Separate tab draft");
      await peerPage.reload();
      await peerPage.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(peerPage);
      await peerPage.locator(".document-file").click();
      assert.equal(await peerPage.locator("#documentSource").inputValue(), "# Separate tab draft");
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      assert.equal(await page.locator("#documentSource").inputValue(), "# Unsaved recovery");
      await peerPage.close();
      checks.push(`${engine.name()}: unsaved drafts remain isolated between tabs after reload`);
      const space = (await api("/api/document-spaces?project=" + project.id, undefined, "get")).spaces[0];
      const record = (await api("/api/documents?space=" + space.id, undefined, "get")).documents[0];
      await api(
        "/api/documents/detail?id=" + record.id,
        { revision: 2, title: "Changed elsewhere", locale: "en", content: "# Peer revision" },
        "put",
      );
      await page.locator('[data-doc-action="save"]').click();
      await page.locator(".document-conflict").waitFor();
      assert.equal(await page.locator("#documentSource").inputValue(), "# Unsaved recovery");
      await page.locator('[data-doc-action="review"]').click();
      assert.equal(await page.locator("#documentDialog textarea").inputValue(), "# Peer revision");
      await page.locator('#documentDialog [type="submit"]').click();
      await page
        .locator("#documentDialog")
        .waitFor({ state: "hidden" })
        .catch(async (error) => {
          console.error(await page.locator("#documentDialog").innerText());
          console.error(
            await page.locator("#documentDialog input").evaluateAll((inputs) =>
              inputs.map((input) => ({
                id: input.id,
                value: input.value,
                valid: input.validity.valid,
                message: input.validationMessage,
              })),
            ),
          );
          await page.screenshot({ path: artifacts + "/failure.png" });
          throw error;
        });
      await page.locator('[data-doc-action="save"]').click();
      await page.waitForFunction(() => /4/.test(document.querySelector(".document-revision")?.textContent || ""));
      await page.locator('[data-doc-action="history"]').click();
      await page.locator("#documentRevisionSelect").waitFor();
      const choices = await page
        .locator("#documentRevisionSelect option")
        .evaluateAll((options) => options.map((o) => o.value));
      await page.locator("#documentRevisionSelect").selectOption(choices[2]);
      await page.waitForFunction(
        (value) => document.querySelector("#documentRevisionPreview")?.value === value,
        content,
      );
      await page.locator('#documentDialog [type="submit"]').click();
      await page.waitForFunction(() => /5/.test(document.querySelector(".document-revision")?.textContent || ""));
      assert.equal(await page.locator("#documentSource").inputValue(), content);
      checks.push(
        `${engine.name()}: conflict preserves draft, explicit comparison/rebase, restoration creates revision 5`,
      );
      await page.locator('[data-doc-action="images"]').click();
      await page.locator("#documentAssetFile").setInputFiles({
        name: "cover-original.png",
        mimeType: "image/png",
        buffer: await sharp({ create: { width: 40, height: 30, channels: 3, background: "#425ee8" } })
          .png()
          .toBuffer(),
      });
      await page.locator(".document-asset").waitFor();
      assert.match(await page.locator(".document-asset").innerText(), /cover-original.png/);
      await page.locator("#doc-alt").fill("Product cover");
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator("#documentDialog").waitFor({ state: "hidden" });
      assert.match(
        await page.locator("#documentSource").inputValue(),
        /!\[Product cover\]\(\/api\/document-assets\/content\?id=/,
      );
      await page.locator('[data-doc-action="preview"]').click();
      await page.waitForFunction(() => document.querySelector("#documentPreview img")?.naturalWidth === 40);
      await page.locator('[data-doc-action="edit"]').click();
      const translation = await api("/api/documents", {
        spaceId: space.id,
        path: "zh/guide.md",
        title: "Chinese edition",
        locale: "zh-CN",
        content: "# 中文版本",
      });
      await page.locator('[data-doc-action="languages"]').click();
      await page.locator(".document-language-option input").check();
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator("#documentDialog").waitFor({ state: "hidden" });
      const languageLinks = await api("/api/document-languages?id=" + record.id, undefined, "get");
      assert.deepEqual(languageLinks.documents.map((d) => d.id).sort(), [record.id, translation.document.id].sort());
      checks.push(`${engine.name()}: private named image upload/insertion/preview and bilingual association`);
      // An unrelated native session event must leave the editor DOM, focus and selection intact.
      await page.locator("#documentSource").focus();
      await page.locator("#documentSource").evaluate((el) => {
        el.setSelectionRange(12, 20);
        window.editorProbe = el;
      });
      await page.evaluate(() => globalThis.__pandaForceDebug.workbench.refresh());
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(
          () => document.activeElement === window.editorProbe && window.editorProbe.selectionStart === 12,
        ),
        true,
      );
      for (const viewportWidth of width === 1440 ? [1440, 1024, 768] : [390, 320]) {
        await page.setViewportSize({ width: viewportWidth, height: 960 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const save = await page.locator('[data-doc-action="save"]').boundingBox();
        assert.ok(save && save.x >= 0 && save.x + save.width <= viewportWidth);
      }
      await page.setViewportSize({ width, height: 960 });
      await page
        .locator("#documentSource")
        .fill(
          "# A clear source\n\nA draft ready for review.\n\n## Next step\n\nPrepare the right version for each channel.",
        );
      await page.screenshot({ path: `${artifacts}/editor-${engine.name()}-${locale}.png`, fullPage: true });
      const heading = await page.locator(".documents-heading h1").innerText();
      assert.equal(heading, locale === "en" ? "Documents & publishing" : "文档与发布");
      assert.deepEqual(errors, []);
      checks.push(`${engine.name()}: localized controls, stable editor during session refresh, responsive widths`);
    } finally {
      await browser.close();
    }
  }
  await writeFile(artifacts + "/browser-results.json", JSON.stringify({ result: "passed", checks }, null, 2));
  console.log(JSON.stringify({ result: "passed", checks }));
} finally {
  await fixture.dispose();
}
