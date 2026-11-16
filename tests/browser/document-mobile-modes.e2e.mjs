import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { webkit, devices } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/document-mobile-modes",
  checks = [];
await mkdir(out, { recursive: true });
const browser = await webkit.launch({ headless: true });
try {
  for (const [locale, theme] of [
    ["en", "aurora"],
    ["zh-CN", "light"],
  ]) {
    const context = await browser.newContext({ ...devices["iPhone 13"], locale });
    await context.addInitScript((theme) => {
      if (["http:", "https:"].includes(location.protocol)) localStorage.setItem("panda-force-theme", theme);
    }, theme);
    await app.signIn(context);
    try {
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const res = await context.request[method](app.base + path, { data });
        assert.ok(res.ok(), await res.text());
        return res.json();
      };
      const catalog = await api("/api/projects", undefined, "get"),
        project = (
          await api("/api/projects", {
            name: "Mobile writing",
            code: ("mobile-" + locale).toLowerCase(),
            revision: catalog.revision,
          })
        ).projects.find((value) => value.code === ("mobile-" + locale).toLowerCase()),
        source = await api("/api/project-documents", {
          projectId: project.id,
          title: "A focused document",
          locale: "en",
        });
      await api(
        "/api/documents/detail?id=" + source.document.id,
        {
          revision: 1,
          title: "A focused document",
          locale: "en",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A document to read before editing." }] }],
            },
          },
        },
        "put",
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.stack || error.message));
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/documents?project=" + project.id + "&document=" + source.document.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const surface = page.locator(".document-rich-content"),
        root = page.locator(".project-document-authoring");
      await surface.locator("text=A document to read before editing.").waitFor();
      assert.equal(await surface.getAttribute("contenteditable"), "false");
      assert.equal(await page.locator("#documentReadTitle").innerText(), "A focused document");
      assert.equal(await page.locator("#documentTitle").isVisible(), false);
      assert.equal(await page.locator(".document-rich-toolbar").isVisible(), false);
      assert.equal(await page.locator("#authoringDirectory").isVisible(), false);
      assert.equal(await page.locator(".documents-heading").isVisible(), false);
      assert.equal((await context.request.get(app.base + "/document-authoring.css")).status(), 200);
      const floating = page.locator(".authoring-reader-tools");
      await floating.waitFor();
      assert.equal(await floating.locator("button").count(), 2);
      await page.screenshot({ path: `${out}/${locale}-reading.png` });

      await page.locator('[data-authoring-action="reader-directory"]').click();
      const directory = page.locator("#authoringDirectory");
      await directory.waitFor();
      assert.equal(await directory.getAttribute("aria-modal"), "true");
      assert.equal(await page.locator("#documentEditor").evaluate((node) => node.inert), true);
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), "documentSearch");
      const sheet = await directory.boundingBox();
      assert.ok(sheet && sheet.width >= 389 && sheet.y > 0 && sheet.height > 400);
      await directory.locator(".authoring-directory-add summary").click();
      assert.equal(await directory.locator('[data-authoring-action="directory-new"]').isVisible(), true);
      await page.screenshot({ path: `${out}/${locale}-directory.png` });
      await directory.locator('[data-authoring-action="directory-dismiss"]').click();
      assert.equal(await page.locator("#documentEditor").evaluate((node) => node.inert), false);

      await page.locator('[data-authoring-action="reader-edit"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      assert.equal(await page.locator(".topbar").isVisible(), false);
      assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), false);
      assert.equal(await page.locator(".authoring-reader-tools").isVisible(), false);
      assert.equal(await page.locator("#documentReadTitle").isVisible(), false);
      assert.equal(
        await page.evaluate(() => document.activeElement?.classList.contains("document-rich-content")),
        true,
      );
      assert.ok(await page.locator(".document-rich-toolbar").isVisible());
      await page.locator("#documentTitle").fill("An edited document");
      await page.locator("#documentTitle").press("Enter");
      // Select after tapping the editor so mobile WebKit receives normal replacement input.
      await surface.click();
      await surface.selectText();
      await page.keyboard.type("Writing should have its own clear state.");
      await surface.selectText();
      await page.waitForFunction(
        () => window.getSelection()?.toString() === "Writing should have its own clear state.",
      );
      await page.locator('[data-rich-action="bold"]').click();
      const layout = async () => {
        const bounds = await page.evaluate(() => ({
            top: window.visualViewport.offsetTop,
            height: window.visualViewport.height,
          })),
          frame = await root.boundingBox(),
          toolbar = await page.locator(".document-rich-toolbar").boundingBox();
        assert.ok(frame && Math.abs(frame.y - bounds.top) < 2);
        assert.ok(frame && Math.abs(frame.height - bounds.height) < 2);
        assert.ok(toolbar && Math.abs(toolbar.y + toolbar.height - bounds.top - bounds.height) < 2);
        const done = await page.locator('[data-doc-action="preview"]').boundingBox();
        assert.ok(done && done.y >= bounds.top && done.y + done.height < bounds.top + bounds.height);
        return { bounds, frame, toolbar, done };
      };
      const normal = await layout();
      await page.screenshot({ path: `${out}/${locale}-editing.png` });
      await page.setViewportSize({ width: 390, height: 420 });
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector(".project-document-authoring").getBoundingClientRect().height -
              window.visualViewport.height,
          ) < 2,
      );
      const contracted = await layout();
      await page.locator('[data-doc-action="preview"]').click();
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      await page.waitForFunction(() =>
        /All changes saved|所有修改已保存/.test(document.querySelector("#documentSaveState")?.textContent || ""),
      );
      assert.equal(await page.locator("#documentReadTitle").innerText(), "An edited document");
      assert.equal(await page.locator(".document-rich-toolbar").isVisible(), false);
      assert.equal(await page.locator(".topbar").isVisible(), true);
      assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), true);
      const saved = await api("/api/documents/detail?id=" + source.document.id, undefined, "get");
      assert.match(saved.revision.content, /Writing should/);
      assert.doesNotMatch(saved.revision.content, /A document to read before editing\./);
      assert.ok(JSON.stringify(saved.revision.body).includes('"bold"'));
      assert.doesNotMatch(await root.innerText(), /documents\.[a-zA-Z]+/);
      assert.deepEqual(errors, []);
      checks.push({ locale, theme, normal, contracted, readingEditingAndDirectory: true });
      console.log(
        `${locale}/${theme}: reader, bottom sheet, explicit focused editing, viewport contraction and done/save passed`,
      );
    } finally {
      await context.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ checks }, null, 2));
} finally {
  await browser.close();
  await app.dispose();
}
