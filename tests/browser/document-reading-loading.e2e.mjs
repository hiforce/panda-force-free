import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  out = ".artifacts/document-reading-loading",
  checks = [];
await mkdir(out, { recursive: true });
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const literal = "<script>window.sourceExecuted=true</script> {literal}";
const runtimePattern = "**/document-rich-runtime.bundle.js*";
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "light"],
    [webkit, 390, "zh-CN", "dark"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
      await context.addInitScript((theme) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const r = await context.request[method](app.base + path, { data });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const catalog = await api("/api/projects"),
        project = (
          await api("/api/projects", {
            code: "reader-" + width,
            name: "Independent reading",
            revision: catalog.revision,
          })
        ).projects.find((p) => p.code === "reader-" + width);
      async function create(title) {
        const tree = await api("/api/project-document-tree?project=" + project.id);
        return api("/api/project-document-tree/documents", {
          id: randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title,
          locale: "en",
          body: { schema: 1, format: "richtext", document: { type: "doc", content: [paragraph("Source content")] } },
        });
      }
      const created = await create("Rich source remains readable"),
        id = created.operation.documentId;
      const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#899cff" } })
        .png()
        .toBuffer();
      const upload = await context.request.post(
        app.base + "/api/document-assets?" + new URLSearchParams({ document: id, name: "original picture.png" }),
        { headers: { "content-type": "image/png" }, data: png },
      );
      assert.ok(upload.ok(), await upload.text());
      const { asset } = await upload.json();
      const body = {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2, textAlign: "center" },
              content: [{ type: "text", text: literal, marks: [{ type: "underline" }, { type: "bold" }] }],
            },
            {
              type: "taskList",
              content: [
                { type: "taskItem", attrs: { checked: true }, content: [paragraph("Retain the checked task")] },
              ],
            },
            {
              type: "codeBlock",
              attrs: { language: "js" },
              content: [{ type: "text", text: 'const source = "<div>";' }],
            },
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      attrs: { colspan: 2, colwidth: [120, 140], align: "right" },
                      content: [paragraph("Merged source cell")],
                    },
                  ],
                },
              ],
            },
            {
              type: "image",
              attrs: {
                src: "/api/document-assets/content?id=" + asset.id,
                alt: "Owned source image",
                title: asset.name,
                width: 48,
                height: 36,
              },
            },
            paragraph("The final source paragraph."),
          ],
        },
      };
      const saved = await api(
        "/api/documents/detail?id=" + id,
        { revision: 1, title: "Rich source remains readable", locale: "en", body },
        "put",
      );
      const other = await create("A different document"),
        otherId = other.operation.documentId;
      const errors = [];
      async function newPage() {
        page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on("pageerror", (e) => errors.push(e.message));
        return page;
      }
      async function open(doc = id) {
        await page.goto(app.base + "/documents?project=" + project.id + "&document=" + doc);
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator("[data-document-reader]").waitFor();
      }
      async function verifyReader() {
        const reader = page.locator("[data-document-reader]");
        assert.equal(await reader.locator("h2").innerText(), literal);
        assert.equal(await reader.locator("h2").evaluate((n) => getComputedStyle(n).textAlign), "center");
        assert.equal(await reader.locator("strong").innerText(), literal);
        assert.equal(await reader.locator("u").innerText(), literal);
        assert.equal(await reader.locator("script").count(), 0);
        assert.equal(await page.evaluate(() => window.sourceExecuted || false), false);
        assert.equal(await reader.locator("input[type=checkbox]").isChecked(), true);
        assert.equal(await reader.locator("input[type=checkbox]").isDisabled(), true);
        assert.equal(await reader.locator("td").getAttribute("colspan"), "2");
        assert.equal(await reader.locator("td").getAttribute("width"), "260");
        assert.equal(await reader.locator("td").evaluate((n) => getComputedStyle(n).textAlign), "right");
        assert.equal(await reader.locator("pre").innerText(), 'const source = "<div>";');
        assert.equal(await reader.locator("img").getAttribute("title"), "original picture.png");
        assert.equal(await reader.locator("img").getAttribute("width"), "48");
        assert.equal(await page.locator(".document-selection-toolbar").count(), 0);
      }
      await newPage();
      let firstTransfers = 0,
        retryTransfers = 0;
      const firstFailure = gate(),
        retry = gate();
      await page.route(runtimePattern, async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("retry") === "1") {
          retryTransfers++;
          await retry.promise;
          await route.continue();
        } else {
          firstTransfers++;
          await firstFailure.promise;
          await route.fulfill({
            status: 503,
            contentType: "text/javascript",
            body: "Temporary fixture transfer failure",
            headers: { "Cache-Control": "no-store" },
          });
        }
      });
      await open();
      await verifyReader();
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      firstFailure.release();
      const retryButton = page.locator('.document-runtime-status[role="alert"] button');
      await retryButton.waitFor();
      await retryButton.click();
      await waitFor(async () => retryTransfers === 1);
      await page.locator(".document-runtime-status").waitFor();
      await page.locator("#documentTitle").fill("Title edited while the writer is loading");
      await waitFor(
        async () =>
          (await api("/api/documents/detail?id=" + id)).revision.title === "Title edited while the writer is loading",
      );
      const pending = await api("/api/documents/detail?id=" + id);
      assert.deepEqual(pending.revision.body, saved.revision.body);
      assert.equal(pending.revision.content, saved.revision.content);
      assert.equal(await page.locator("#documentTitle").evaluate((n) => n === document.activeElement), true);
      retry.release();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      assert.equal(
        await page.locator("#documentTitle").evaluate((n) => n === document.activeElement),
        true,
        "Late editor loading must not steal a title selection",
      );
      assert.equal(firstTransfers, 1);
      assert.equal(retryTransfers, 2, "Warming fetches bytes; the subsequent import evaluates the module once");
      assert.equal(await page.locator(".document-selection-toolbar").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: out + "/" + engine.name() + "-retry-ready.png" });
      await page.close();

      await newPage();
      const recoveringRequests = [];
      let failedDownloads = 0;
      await page.route(runtimePattern, async (route) => {
        const request = route.request();
        recoveringRequests.push({
          entry: new URL(request.url()).searchParams.get("retry"),
          type: request.resourceType(),
        });
        if (failedDownloads < 3) {
          assert.equal(request.resourceType(), "fetch", "Failed preparation must not enter the module map");
          const html = ++failedDownloads === 3;
          return route.fulfill({
            status: html ? 200 : 503,
            contentType: html ? "text/html" : "text/javascript",
            body: html ? "<html><script>window.wrongRuntimeExecuted=true</script>Sign in</html>" : "Temporary outage",
            headers: { "Cache-Control": "no-store" },
          });
        }
        return route.continue();
      });
      await open();
      assert.equal(failedDownloads, 0, "Reading must not prepare the heavy editor");
      await page.evaluate(() => {
        window.recoveryPageIdentity = "same-document";
      });
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      await waitFor(async () => failedDownloads === 1);
      await page.locator('.document-runtime-status[role="alert"] button').click();
      await waitFor(async () => failedDownloads === 2);
      await page.locator('.document-runtime-status[role="alert"] button').click();
      await waitFor(async () => failedDownloads === 3);
      await page.locator('.document-runtime-status[role="alert"] button').waitFor();
      await verifyReader();
      assert.equal(await page.evaluate(() => window.wrongRuntimeExecuted || false), false);
      await page.screenshot({ path: out + "/" + engine.name() + "-repeated-download-failure.png" });
      await page.locator('.document-runtime-status[role="alert"] button').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      assert.equal(await page.evaluate(() => window.recoveryPageIdentity), "same-document");
      assert.deepEqual(recoveringRequests.slice(0, 3), [
        { entry: null, type: "fetch" },
        { entry: "1", type: "fetch" },
        { entry: "1", type: "fetch" },
      ]);
      assert.equal(recoveringRequests.filter((request) => request.type === "script").length, 1);
      assert.deepEqual((await api("/api/documents/detail?id=" + id)).revision.body, saved.revision.body);
      await page.screenshot({ path: out + "/" + engine.name() + "-recovered-without-refresh.png" });
      await page.close();

      await newPage();
      const delayed = gate();
      await page.route(runtimePattern, async (route) => {
        await delayed.promise;
        await route.continue();
      });
      await open();
      await verifyReader();
      const oldReader = await page.locator("[data-document-reader]").elementHandle();
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      await page.locator(".document-runtime-status").waitFor();
      await page.locator('[data-doc-action="preview"]').click();
      assert.equal(await page.locator("#documentRichEditor").getAttribute("aria-busy"), null);
      await page.locator(width > 700 ? ".authoring-workspace-back" : ".authoring-project-back").click();
      await waitFor(async () => !(await oldReader.evaluate((n) => n.isConnected)));
      delayed.release();
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator(".document-rich-content").count(), 0);
      assert.equal(await page.locator(".document-selection-toolbar").count(), 0);
      await page.locator('[data-directory-open="' + id + '"]').click();
      await page.locator("#documentReadTitle").waitFor();
      if (width <= 700) await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator('[data-tree-id="' + otherId + '"] .document-tree-title').click();
      await page.locator("[data-document-reader]").waitFor();
      assert.equal(await page.locator("#documentReadTitle").innerText(), "A different document");
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      assert.equal(await page.locator(".document-selection-toolbar").count(), 1);
      await page.close();

      await newPage();
      let evaluationTransfers = 0;
      await page.route(runtimePattern, async (route) => {
        evaluationTransfers++;
        await route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: 'window.fixtureModuleExecutions=(window.fixtureModuleExecutions||0)+1; throw new Error("Isolated runtime evaluation failure"); export function createRichDocumentEditor() {};',
        });
      });
      await open();
      await verifyReader();
      assert.equal(
        await page.evaluate(() => window.fixtureModuleExecutions || 0),
        0,
        "Preparation must not evaluate the runtime",
      );
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      await page.locator('.document-runtime-status[role="alert"]').waitFor();
      assert.equal(await page.locator(".document-runtime-status button").count(), 0);
      await verifyReader();
      await page.locator('[data-doc-action="preview"]').click();
      await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
      await page.locator('.document-runtime-status[role="alert"]').waitFor();
      assert.equal(await page.evaluate(() => window.fixtureModuleExecutions), 1);
      assert.equal(evaluationTransfers, 2);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: out + "/" + engine.name() + "-safe-failure.png" });
      checks.push({
        engine: engine.name(),
        width,
        locale,
        theme,
        readingIndependentOfRuntime: true,
        richSemanticsRetained: true,
        fixedTransferEntries: true,
        repeatedDownloadsRecoverWithoutRefresh: true,
        wrongMimeDoesNotPoisonModuleMap: true,
        lateTitleSavePreserved: true,
        lateFocusPreserved: true,
        cancellationAndNavigationFenced: true,
        evaluationNeverRepeated: true,
      });
      await context.close();
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: out + "/" + engine.name() + "-failed.png" });
        await writeFile(out + "/" + engine.name() + "-failed.html", await page.content());
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(checks, null, 2));
