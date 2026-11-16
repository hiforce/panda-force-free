import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
const artifacts = ".artifacts/project-document-authoring";
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
        const response = await context.request[method](fixture.base + path, { data });
        assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const created = await api("/api/projects", {
        name: "Project knowledge",
        code: "authoring-" + width,
        revision: catalog.revision,
      });
      const project = created.projects.find((project) => project.code === "authoring-" + width);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15_000);
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-authoring-action="new"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      await page.locator("#documentTitle").fill("Guides");
      const parentId = new URL(page.url()).searchParams.get("document");
      await waitFor(
        async () =>
          (await api("/api/documents/detail?id=" + parentId, undefined, "get")).document.title === "Guides" &&
          (await page.locator('[data-doc-action="save"]').isDisabled()),
      );
      await page.locator('[data-doc-action="preview"]').click();
      if (width < 700) await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator('[data-tree-id="' + parentId + '"] .document-tree-more').click();
      await page.locator('[data-node-command="new-child"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      await page.locator("#documentTitle").fill("A useful handbook");
      await page.locator("#documentTitle").press("Enter");
      await page.waitForFunction(() => document.activeElement?.classList.contains("document-rich-content"));
      const surface = page.locator(".document-rich-content");
      await surface.fill("Clear writing starts here.");
      await surface.press("ControlOrMeta+a");
      await page
        .waitForFunction(() => window.getSelection()?.toString().trim() === "Clear writing starts here.")
        .catch(async (error) => {
          console.error(
            "Text selection failed",
            width,
            await surface.evaluate((element) => ({
              selection: window.getSelection()?.toString(),
              focused: document.activeElement === element,
              html: element.innerHTML,
            })),
          );
          throw error;
        });
      await page.locator('[data-rich-action="bold"]').click();
      await surface.locator("strong").filter({ hasText: "Clear writing starts here." }).waitFor();
      // Defer native selection events to cover fast navigation followed by input before the next browser frame.
      await page.evaluate(() => {
        const defer = (event) => event.stopImmediatePropagation();
        document.addEventListener("selectionchange", defer, true);
        window.releaseDocumentSelectionEvents = () => document.removeEventListener("selectionchange", defer, true);
      });
      try {
        await surface.press("ArrowRight");
        await surface.press("End");
        await surface.press("Enter");
        await surface.pressSequentially("A second paragraph.");
      } finally {
        await page.evaluate(() => window.releaseDocumentSelectionEvents());
      }
      await page.waitForFunction(() =>
        document.querySelector("#documentSaveState")?.textContent?.match(/All changes saved|所有修改已保存/),
      );
      const id = new URL(page.url()).searchParams.get("document");
      assert.ok(id);
      let detail = await api("/api/documents/detail?id=" + id, undefined, "get");
      assert.equal(detail.revision.title, "A useful handbook");
      const tree = await api("/api/project-document-tree?project=" + project.id, undefined, "get");
      assert.equal(tree.nodes.find((node) => node.documentId === id).parentId, parentId);
      assert.match(detail.document.path, /^[a-f0-9-]+\.md$/);
      assert.ok(JSON.stringify(detail.revision.body).includes('"bold"'), JSON.stringify(detail.revision.body));
      assert.match(detail.revision.content, /Clear writing/);
      assert.match(detail.revision.content, /A second paragraph\./);
      assert.equal((await api("/api/document-spaces?project=" + project.id, undefined, "get")).spaces.length, 0);
      await page.locator('[data-rich-action="table"]').click();
      await surface.locator("table").waitFor();
      const image = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#a4c4ff" } })
        .png()
        .toBuffer();
      await surface.evaluate((element, base64) => {
        element.focus();
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([bytes], "reference.png", { type: "image/png" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
        );
      }, image.toString("base64"));
      await surface.locator('img[src^="/api/document-assets/content?id="]').waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-doc-action="save"]')?.disabled &&
          !document.querySelector(".document-image-upload"),
      );
      detail = await api("/api/documents/detail?id=" + id, undefined, "get");
      assert.ok(JSON.stringify(detail.revision.body).includes('"table"'));
      assert.ok(JSON.stringify(detail.revision.body).includes('"image"'));
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      assert.equal(await page.locator("#documentTitle").inputValue(), "A useful handbook");
      assert.equal(await surface.locator("table").count(), 1);
      assert.equal(await surface.locator("img").count(), 1);
      assert.equal(await page.locator(".document-rich-toolbar").isVisible(), false);
      assert.equal(await page.locator("#documentTitle").getAttribute("readonly"), "");
      await page.screenshot({ path: artifacts + "/" + width + "-reading.png", fullPage: true });
      await page.locator(width < 700 ? '[data-authoring-action="reader-edit"]' : '[data-doc-action="edit"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      let releaseSave;
      let heldSave = false;
      let delayFirst = true;
      const savedResponse = new Promise((resolve) => {
        releaseSave = resolve;
      });
      await page.route("**/api/documents/detail?id=" + id, async (route) => {
        if (route.request().method() !== "PUT" || !delayFirst) return route.continue();
        delayFirst = false;
        const response = await route.fetch();
        heldSave = true;
        await savedResponse;
        await route.fulfill({ response });
      });
      await page.locator("#documentTitle").fill("Edited while saving");
      await waitFor(() => heldSave);
      await page.locator("#documentTitle").fill("Final title survives a slow save");
      releaseSave();
      await waitFor(async () => {
        const current = await api("/api/documents/detail?id=" + id, undefined, "get");
        return (
          current.revision.title === "Final title survives a slow save" &&
          page.locator('[data-doc-action="save"]').isDisabled()
        );
      });
      assert.equal(await page.locator("#documentTitle").inputValue(), "Final title survives a slow save");
      assert.equal(
        await page.locator("#documentTitle").evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
        true,
      );
      await page.unroute("**/api/documents/detail?id=" + id);
      await page.locator("#documentTitle").fill("  Trim this title  ");
      await waitFor(
        async () =>
          (await page.locator("#documentTitle").inputValue()) === "Trim this title" &&
          (await page.locator('[data-doc-action="save"]').isDisabled()),
      );
      const normalized = await api("/api/documents/detail?id=" + id, undefined, "get");
      await page.waitForTimeout(1800);
      assert.equal(
        (await api("/api/documents/detail?id=" + id, undefined, "get")).document.revision,
        normalized.document.revision,
      );

      await page.screenshot({ path: artifacts + "/" + width + "-editing.png", fullPage: true });
      if (engine === chromium) {
        await page.setViewportSize({ width: 2048, height: 960 });
        for (const mode of ["comfortable", "wide", "fill"]) {
          await page.locator('[data-chrome-menu="layout"]').click();
          await page.locator(`[data-chrome-action="width"][data-value="${mode}"]`).click();
          const geometry = await page.locator(".document-rich-surface").evaluate((node) => ({
            content: node.querySelector(".document-rich-content").getBoundingClientRect().width,
            canvas: node.closest(".document-canvas").getBoundingClientRect().width,
            title: document.querySelector("#documentTitle").getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
          assert.equal(geometry.overflow, false);
          assert.ok(Math.abs(geometry.content - geometry.title) < 2, JSON.stringify(geometry));
          assert.ok(
            mode === "comfortable" ? geometry.content <= 901 : geometry.content >= geometry.canvas - 90,
            JSON.stringify(geometry),
          );
          await page.screenshot({ path: `${artifacts}/document-${mode}-2048.png` });
        }
        await page.locator('[data-chrome-menu="layout"]').click();
        await page.locator('[data-chrome-action="width"][data-value="comfortable"]').click();
        await page.setViewportSize({ width, height: 960 });
      }
      await page.locator(".document-editor-more summary").click();
      await page.locator('[data-doc-action="history"]').click();
      await page.locator("#documentRevisionSelect").waitFor();
      await page.locator("#documentRichRevisionPreview .document-rich-content").waitFor();
      const revisions = await page.locator("#documentRevisionSelect option").count();
      assert.ok(revisions >= 3);
      await page.locator("#authoringDocumentDialog [data-doc-close]").click();
      assert.ok(await page.locator('[data-authoring-action="trash-document"]').isEnabled());
      await (async () => {
        if (width < 700) {
          if (await page.locator('.document-rich-content[contenteditable="true"]').count())
            await page.locator('[data-doc-action="preview"]').click();
          if (!(await page.locator("#authoringDirectory").isVisible()))
            await page
              .locator(
                '[data-authoring-action="reader-directory"]:visible, [data-authoring-action="directory"]:visible',
              )
              .click();
        }
        await page.locator(".document-workspace-more summary").click();
      })();
      await page.locator('[data-authoring-action="trash-document"]').click();
      await page.locator('#authoringDocumentDialog [type="submit"]').click();
      await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      await (async () => {
        if (width < 700) {
          if (await page.locator('.document-rich-content[contenteditable="true"]').count())
            await page.locator('[data-doc-action="preview"]').click();
          if (!(await page.locator("#authoringDirectory").isVisible()))
            await page
              .locator(
                '[data-authoring-action="reader-directory"]:visible, [data-authoring-action="directory"]:visible',
              )
              .click();
        }
        await page.locator(".document-workspace-more summary").click();
      })();
      await page.locator('[data-authoring-action="trash"]').click();
      await page.locator("[data-trash-restore]").click();
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      assert.equal(await surface.locator("img").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.equal(/documents\.[a-zA-Z]+/.test(await page.locator(".project-document-authoring").innerText()), false);
      const legacySpace = (
        await api("/api/document-spaces", {
          projectId: project.id,
          code: "legacy",
          name: "Connected source",
          engine: "markdown",
          sourceMode: "managed",
          locale: "en",
        })
      ).space;
      await api("/api/documents", {
        spaceId: legacySpace.id,
        path: "source.md",
        title: "A connected source document",
        locale: "en",
        content: "Independent source",
      });
      let releaseOverview;
      const overviewPending = new Promise((resolve) => {
        releaseOverview = resolve;
      });
      await page.route("**/api/project-document-tree?project=" + project.id, async (route) => {
        const response = await route.fetch();
        await overviewPending;
        await route.fulfill({ response });
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator('[data-authoring-action="sources"]').waitFor({ state: "attached" });
      await (async () => {
        if (width < 700) {
          if (await page.locator('.document-rich-content[contenteditable="true"]').count())
            await page.locator('[data-doc-action="preview"]').click();
          if (!(await page.locator("#authoringDirectory").isVisible()))
            await page
              .locator(
                '[data-authoring-action="reader-directory"]:visible, [data-authoring-action="directory"]:visible',
              )
              .click();
        }
        await page.locator(".document-workspace-more summary").click();
      })();
      await page.locator('[data-authoring-action="sources"]').click();
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Unsent connected-source draft");
      releaseOverview();
      await page.waitForTimeout(250);
      assert.match(await page.locator("#documentTree").innerText(), /A connected source document/);
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsent connected-source draft");
      await page.unroute("**/api/project-document-tree?project=" + project.id);
      await page.locator('[data-authoring-action="back"]').click();
      await page.locator('[data-authoring-action="new"]').waitFor();
      assert.equal((await page.locator("#documentTree").innerText()).includes("A connected source document"), false);
      assert.deepEqual(errors, []);
      checks.push(
        `${engine.name()} ${locale}: first-use folders, visual writing, bold/table/pasted owned image, autosave with in-flight typing, deep-link reload, reading, rich history, folder rename, trash/restore, delayed navigation isolation and viewport`,
      );
      await context.close();
    } catch (error) {
      await writeFile(artifacts + "/failure.txt", String(error.stack || error));
      throw error;
    } finally {
      await browser.close();
    }
  }
  await writeFile(artifacts + "/checks.json", JSON.stringify(checks, null, 2));
  console.log(checks.join("\n"));
} finally {
  await fixture.dispose();
}
