import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { verifyDocumentToolbar } from "../support/document-toolbar.mjs";

const app = await createAppFixture(),
  out = ".artifacts/document-editor-controls",
  checks = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "light"],
    [chromium, 1100, "zh-CN", "aurora"],
    [webkit, 390, "zh-CN", "light"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
      await context.addInitScript((theme) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const api = async (path, data) => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const r = await context.request[data ? "post" : "get"](app.base + path, { data });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const catalog = await api("/api/projects"),
        project = (
          await api("/api/projects", {
            code: "controls-" + width,
            name: "Writing workspace",
            revision: catalog.revision,
          })
        ).projects.find((p) => p.code === "controls-" + width),
        created = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: 0,
          title: "Working with documents",
          locale: "en",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Selected text stays selected." }] },
                { type: "paragraph", content: [{ type: "text", text: "A second block remains editable." }] },
              ],
            },
          },
        }),
        id = created.operation.documentId,
        errors = [];
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.stack || error.message));
      page.setDefaultTimeout(15000);
      let runtimeRequests = 0;
      const runtimeRequestTypes = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/document-rich-runtime.bundle.js") {
          runtimeRequests++;
          runtimeRequestTypes.push(request.resourceType());
        }
      });
      await page.goto(app.base + "/");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      assert.equal(runtimeRequests, 0, "The ordinary workspace must not download the editor runtime");
      let releaseRuntime;
      const runtimeGate = new Promise((resolve) => (releaseRuntime = resolve));
      const runtimePattern = "**/document-rich-runtime.bundle.js";
      await page.route(runtimePattern, async (route) => {
        await runtimeGate;
        await route.continue();
      });
      const navigation = page.locator(width > 700 ? ".workbench-navigation" : ".workbench-mobile-nav");
      await navigation.locator('[data-wb="route"][data-route="projects"]').click();
      assert.equal(runtimeRequests, 0, "The project list must not download the editor runtime");
      await page
        .locator('#workbenchContent [data-wb="route"][data-route="/documents?project=' + project.id + '"]')
        .click();
      const documentLink = page.locator('[data-tree-id="' + id + '"] .document-tree-title');
      await documentLink.waitFor({ state: "attached" });
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      await page.locator("[data-document-reader]").waitFor();
      assert.match(await page.locator("[data-document-reader]").innerText(), /Selected text stays selected/);
      assert.equal(await page.locator(".document-selection-toolbar").count(), 0);
      assert.equal(runtimeRequests, 0, "Reading an existing document must not download the editor runtime");
      const workspaceStyle = await context.request.get(app.base + "/document-workspace.css");
      assert.equal(workspaceStyle.status(), 200);
      assert.match(workspaceStyle.headers()["content-type"], /text\/css/);
      const runtimeRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/document-rich-runtime.bundle.js",
      );
      if (width > 700) {
        const frame = await page.locator(".project-document-authoring").boundingBox(),
          main = await page.locator("#workbenchView").boundingBox(),
          header = await page.locator(".document-authoring-editor-header").boundingBox(),
          treeHeader = await page.locator(".project-document-authoring>.documents-heading").boundingBox(),
          title = await page.locator("#documentReadTitle").boundingBox(),
          breadcrumb = await page.locator("#authoringBreadcrumb").boundingBox(),
          save = await page.locator("#documentSaveState").boundingBox();
        await page.screenshot({ path: `${out}/${width}-initial.png` });
        assert.ok(
          frame && main && Math.abs(frame.x - main.x) < 2 && frame.width >= main.width - 2,
          "Document workspace must use the available main column",
        );
        assert.ok(
          header && treeHeader && Math.abs(header.y - treeHeader.y) < 2 && header.height <= 56,
          "Directory and document controls must share one compact header band",
        );
        assert.ok(title && title.y - header.y - header.height <= 48, "The document title must start near the header");
        assert.ok(
          breadcrumb && save && Math.abs(breadcrumb.y + breadcrumb.height / 2 - (save.y + save.height / 2)) < 3,
          "Breadcrumb and save state must stay on one line",
        );
        await page.locator('[data-doc-action="edit"]').click();
      } else await page.locator('[data-authoring-action="reader-edit"]').click();
      await runtimeRequest;
      releaseRuntime();
      const surface = page.locator('.document-rich-content[contenteditable="true"]');
      await surface.waitFor();
      await page.screenshot({ path: `${out}/${width}-editing-initial.png` });
      if (width > 700) {
        const first = surface.locator("p").first();
        await first.click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        const selection = page.locator(".document-selection-toolbar");
        await selection.waitFor();
        assert.equal(await page.evaluate(() => getSelection().toString()), "Selected text stays selected.");
        await selection.locator('[data-selection-action="bold"]').click();
        await surface.locator("strong").waitFor();
        assert.equal(await page.evaluate(() => getSelection().toString()), "Selected text stays selected.");
        await selection.locator("select").selectOption("2");
        await surface.locator("h2").waitFor();
        assert.equal(await surface.locator("h2").innerText(), "Selected text stays selected.");
        await waitFor(async () => await surface.evaluate((node) => node === document.activeElement));
        await page.keyboard.press("Escape");
        assert.equal(await selection.isVisible(), false);
      } else assert.equal(await page.locator(".document-selection-toolbar").isVisible(), false);
      await surface.locator("p").last().click();
      // Native selection changes reach the editor model asynchronously; await the actual cursor before typing.
      await waitFor(
        async () =>
          await surface.evaluate(
            (node) =>
              node.editor.state.selection.empty &&
              node.editor.state.selection.$from.parent.textContent === "A second block remains editable.",
          ),
      );
      assert.equal(
        await surface
          .locator("p")
          .last()
          .evaluate((node) => node.contains(getSelection().anchorNode)),
        true,
        "Clicking the last paragraph must place the cursor in that paragraph",
      );
      await page.keyboard.press("End");
      assert.equal(await page.evaluate(() => getSelection().isCollapsed), true);
      await page.keyboard.press("Enter");
      assert.match(await surface.innerText(), /Selected text stays selected\./);
      await page.locator('[data-doc-action="insert-content"]').click();
      const insert = page.locator(".document-insert-menu");
      await insert.waitFor();
      assert.equal(await insert.locator("button").count(), 5);
      const box = await insert.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 900,
        "Insertion menu must remain inside the viewport",
      );
      await insert.locator('[data-insert-action="codeBlock"]').click();
      await surface.locator(".document-code-block").waitFor();
      await waitFor(
        async () =>
          await surface.locator(".document-code-block .cm-content").evaluate((node) => node === document.activeElement),
      );
      await page.keyboard.type("const version = 'saved';");
      if (width > 700) {
        await surface.locator(".document-code-block").hover();
        await page.locator(".document-block-handle").waitFor();
        await page.locator(".document-block-handle").click();
      } else await page.locator("[data-rich-block-toggle]").click();
      const block = page.locator(".document-block-menu");
      await block.waitFor();
      await block.locator('[data-block-action="duplicate"]').click();
      await waitFor(async () => (await surface.locator(".document-code-block").count()) === 2);
      await page.locator('[data-rich-action="undo"]').click();
      await waitFor(async () => (await surface.locator(".document-code-block").count()) === 1);
      assert.equal(await surface.locator(".document-code-block .cm-content").innerText(), "const version = 'saved';");
      await page.locator("[data-rich-block-toggle]").click();
      await block.waitFor();
      assert.equal(await block.locator('[data-block-action="down"]').isDisabled(), false);
      await block.locator('[data-block-action="up"]').click();
      await waitFor(
        async () =>
          await surface
            .locator(".document-code-block")
            .evaluate((node) => node.nextElementSibling?.textContent === "A second block remains editable."),
      );
      await page.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="down"]').click();
      await waitFor(
        async () =>
          await surface
            .locator(".document-code-block")
            .evaluate((node) => node.previousElementSibling?.textContent === "A second block remains editable."),
      );
      await page.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="delete"]').click();
      await waitFor(async () => (await surface.locator(".document-code-block").count()) === 0);
      await page.locator('[data-rich-action="undo"]').click();
      await surface.locator(".document-code-block").waitFor();
      assert.equal(await surface.locator(".document-code-block .cm-content").innerText(), "const version = 'saved';");
      await page.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="paragraph"]').click();
      await waitFor(async () => (await surface.locator(".document-code-block").count()) === 0);
      assert.match(await surface.innerText(), /const version = 'saved';/);
      await page.locator('[data-rich-action="bulletList"]').click();
      await surface.locator("ul").waitFor();
      await page.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="paragraph"]').click();
      await waitFor(async () => (await surface.locator("ul").count()) === 0);
      assert.match(await surface.innerText(), /const version = 'saved';/);
      await page.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="codeBlock"]').click();
      await surface.locator(".document-code-block").waitFor();
      if (engine === chromium) {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.locator("[data-rich-block-toggle]").click();
        await block.locator('[data-block-action="copy"]').click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /const version = 'saved';/);
        await waitFor(async () => await surface.evaluate((node) => node.contains(document.activeElement)));
      }
      await waitFor(async () => await page.locator('[data-doc-action="save"]').isDisabled());
      const saved = await api("/api/documents/detail?id=" + id);
      assert.match(saved.revision.content, /const version/);
      assert.match(saved.revision.content, /Selected text stays selected\./);
      assert.match(saved.revision.content, /A second block remains editable\./);
      if (width > 700) assert.equal(saved.revision.body.document.content[0].type, "heading");
      await page.screenshot({ path: `${out}/${engine.name()}-${width}-${theme}-editing.png` });
      await page.locator('[data-doc-action="preview"]').click();
      assert.equal(await page.locator(".document-selection-toolbar").isVisible(), false);
      assert.equal(await page.locator(".document-block-handle").isVisible(), false);
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content .document-code-block .cm-content").waitFor();
      assert.equal(await page.locator(".document-rich-content .document-code-block .cm-content").count(), 1);
      assert.equal(await page.locator(".document-selection-toolbar").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/${engine.name()}-${width}-${theme}-reading.png` });
      assert.deepEqual(
        runtimeRequestTypes,
        ["fetch", "script"],
        "Only editing downloads and executes the runtime; reading and reloading remain independent",
      );
      await verifyDocumentToolbar({
        page,
        api,
        project,
        base: app.base,
        width,
        out,
        label: `${engine.name()}-${width}-${theme}`,
      });
      assert.deepEqual(errors, []);
      checks.push({
        engine: engine.name(),
        width,
        locale,
        theme,
        compactHeader: true,
        selection: width > 700,
        insert: true,
        blockDuplicateUndo: true,
        blockMoveDeleteTransformUndo: true,
        copy: engine === chromium,
        persistent: true,
        toolbarScrollAndTeardown: true,
        routeWarmupBeforeTreeResponse: true,
      });
      await context.close();
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: `${out}/${width}-failed.png` });
        await writeFile(`${out}/${width}-failed.html`, await page.content());
      }
      await writeFile(out + "/failure.txt", error.stack || String(error));
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(checks, null, 2));
