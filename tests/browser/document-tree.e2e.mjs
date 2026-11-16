import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit, devices } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  out = ".artifacts/document-tree",
  checks = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, nativeTouch] of [
    [chromium, 1440, "en", false],
    [chromium, 390, "zh-CN", true],
    [webkit, 390, "en", false],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    const context = await browser.newContext({
      ...(width < 700 ? devices["iPhone 13"] : { viewport: { width, height: 960 } }),
      locale,
    });
    await app.signIn(context);
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    const api = async (path, data, method = "get") => {
      if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
      const response = await context.request[method](app.base + path, { data });
      assert.ok(response.ok(), await response.text());
      return response.json();
    };
    try {
      const catalog = await api("/api/projects"),
        code = "tree-" + engine.name() + "-" + width;
      const project = (
        await api("/api/projects", { name: "Document tree", code, revision: catalog.revision }, "post")
      ).projects.find((p) => p.code === code);
      const snapshot = () => api("/api/project-document-tree?project=" + project.id);
      const seed = async (title) =>
        api(
          "/api/project-document-tree/documents",
          { id: crypto.randomUUID(), projectId: project.id, treeVersion: (await snapshot()).version, title },
          "post",
        );
      const parent = (await seed("Project guide")).operation.documentId,
        other = (await seed("Research")).operation.documentId;
      await page.goto(app.base + "/documents?project=" + project.id + "&document=" + parent);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content").waitFor();
      const directory = async () => {
        if (width < 700) {
          if (await page.locator('.document-rich-content[contenteditable="true"]').count())
            await page.locator('[data-doc-action="preview"]').click();
          if (!(await page.locator("#authoringDirectory").isVisible()))
            await page
              .locator('[data-authoring-action="reader-directory"]:visible,[data-authoring-action="directory"]:visible')
              .click();
        }
      };
      const row = (id) => page.locator('[data-tree-id="' + id + '"]');
      const menu = async (id, action) => {
        await directory();
        await row(id).locator(".document-tree-more").click();
        const bounds = await page.locator(".document-tree-menu").boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.locator('[data-node-command="' + action + '"]').click();
      };
      await menu(parent, "new-child");
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      await page.locator("#documentTitle").fill("Child document");
      await page.locator(".document-rich-content").fill("A persistent child source.");
      const child = new URL(page.url()).searchParams.get("document");
      assert.ok(child && child !== parent);
      await waitFor(async () => {
        const detail = await api("/api/documents/detail?id=" + child);
        return (
          detail.document.title === "Child document" &&
          detail.revision.content.includes("persistent child") &&
          (await page.locator('[data-doc-action="save"]').isDisabled())
        );
      });
      await page.locator('[data-doc-action="preview"]').click();
      let original = await api("/api/documents/detail?id=" + child);
      assert.equal((await snapshot()).nodes.find((n) => n.documentId === child).parentId, parent);
      if (width > 700) {
        await page.evaluate(() => (window.__renamedEditor = document.querySelector(".document-rich-content")));
        await menu(child, "rename");
        await page.locator("#doc-title").fill("Child document revised");
        await page.locator('#authoringDocumentDialog [type="submit"]').click();
        await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
        assert.equal(await page.locator("#documentReadTitle").innerText(), "Child document revised");
        assert.equal(
          await page.evaluate(() => window.__renamedEditor === document.querySelector(".document-rich-content")),
          true,
        );
        assert.equal(
          await page.locator(".document-revision").innerText(),
          "Revision " + (original.document.revision + 1),
        );
        await page.locator('[data-doc-action="edit"]').click();
        await page.locator('.document-rich-content[contenteditable="true"]').fill("Content saved after a tree rename.");
        await waitFor(
          async () =>
            (await api("/api/documents/detail?id=" + child)).revision.content.includes("after a tree rename") &&
            (await page.locator('[data-doc-action="save"]').isDisabled()),
        );
        await page.locator('[data-doc-action="preview"]').click();
        original = await api("/api/documents/detail?id=" + child);
      }
      await directory();
      await page.evaluate(() => (window.__treeEditor = document.querySelector(".document-rich-content")));
      await page.locator("#documentSearch").fill("Child document");
      await row(child).waitFor();
      await row(other).waitFor({ state: "hidden" });
      assert.equal(await row(parent).count(), 1);
      assert.equal(await row(other).count(), 0);
      await page.locator("#documentSearch").fill("");
      await row(other).waitFor();
      const baseLocale = locale === "zh-CN" ? "zh-CN" : "en",
        otherLocale = baseLocale === "en" ? "zh-CN" : "en";
      await page.locator("#documentSearch").fill("Child");
      await row(other).waitFor({ state: "hidden" });
      await page.locator("#documentSearch").evaluate((input) => input.setSelectionRange(1, 3));
      await page.evaluate(async (locale) => window.__pandaForceI18n.setPreference(locale), otherLocale);
      assert.equal(
        await page.locator(".document-tree-root").innerText(),
        otherLocale === "en" ? "Project root" : "项目根目录",
      );
      assert.match(
        await page.locator("#authoringBreadcrumb").innerText(),
        otherLocale === "en" ? /Project root/ : /项目根目录/,
      );
      assert.deepEqual(
        await page
          .locator("#documentSearch")
          .evaluate((input) => [
            input === document.activeElement,
            input.value,
            input.selectionStart,
            input.selectionEnd,
          ]),
        [true, "Child", 1, 3],
      );
      await row(child).locator(".document-tree-more").click();
      assert.equal(
        await page.locator('[data-node-command="new-child"]').innerText(),
        otherLocale === "en" ? "New child document" : "新建子文档",
      );
      await page.evaluate(async (locale) => window.__pandaForceI18n.setPreference(locale), baseLocale);
      assert.equal(
        await page.locator('[data-node-command="new-child"]').innerText(),
        baseLocale === "en" ? "New child document" : "新建子文档",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => window.__treeEditor === document.querySelector(".document-rich-content")),
        true,
      );
      assert.deepEqual(await api("/api/documents/detail?id=" + child), original);
      await page.locator("#documentSearch").fill("");
      await row(other).waitFor();
      await row(parent).locator(".document-tree-expand").click();
      assert.equal(await row(child).count(), 0);
      await row(parent).locator(".document-tree-title").focus();
      await page.keyboard.press("ArrowRight");
      await row(child).waitFor();
      await menu(parent, "rename");
      await page.locator("#doc-title").fill("Product handbook");
      await page.locator('#authoringDocumentDialog [type="submit"]').click();
      await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#documentReadTitle").innerText(), original.document.title);
      assert.match(await page.locator("#authoringBreadcrumb").innerText(), /Product handbook/);
      assert.equal(
        await page.evaluate(() => window.__treeEditor === document.querySelector(".document-rich-content")),
        true,
      );
      assert.deepEqual(await api("/api/documents/detail?id=" + child), original);
      if (engine === chromium) {
        await directory();
        const source = await row(child).locator(".document-tree-handle").boundingBox(),
          target = await row(other).boundingBox();
        assert.ok(source && target);
        const x = source.x + source.width / 2,
          y = source.y + source.height / 2,
          tx = target.x + target.width / 2,
          ty = target.y + target.height / 2;
        if (!nativeTouch) {
          const version = (await snapshot()).version;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(tx, ty, { steps: 12 });
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await row(child).locator(".document-tree-more").click();
          await page.locator(".document-tree-menu").waitFor();
          await page.keyboard.press("Escape");
          assert.equal((await snapshot()).version, version);
          assert.equal(await page.locator(".tree-dragging").count(), 0);
        }
        if (nativeTouch) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
          await page.waitForTimeout(330);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: tx, y: ty, id: 1 }] });
          await page.waitForTimeout(120);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await cdp.detach();
        } else {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(tx, ty, { steps: 12 });
          await page.mouse.up();
        }
        await waitFor(async () => (await snapshot()).nodes.find((n) => n.documentId === child).parentId === other);
        assert.deepEqual(await api("/api/documents/detail?id=" + child), original);
        await menu(child, "move");
        await page.locator("#documentMoveSearch").fill("Product");
        await page.evaluate(async (locale) => window.__pandaForceI18n.setPreference(locale), otherLocale);
        assert.equal(
          await page.locator("#authoringDocumentDialog h2").innerText(),
          otherLocale === "en" ? "Move document" : "移动文档",
        );
        assert.deepEqual(
          await page
            .locator("#documentMoveSearch")
            .evaluate((input) => [input === document.activeElement, input.value]),
          [true, "Product"],
        );
        await page.evaluate(async (locale) => window.__pandaForceI18n.setPreference(locale), baseLocale);
        await page.locator('#documentMoveOptions input[value="' + parent + '"]').check();
        await page.locator('#authoringDocumentDialog [type="submit"]').click();
        await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      } else {
        await menu(child, "move");
        await page.locator("#documentMoveSearch").fill("Research");
        await page.locator('#documentMoveOptions input[value="' + other + '"]').check();
        await page.locator('#authoringDocumentDialog [type="submit"]').click();
        await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
        await menu(child, "move");
        await page.locator("#documentMoveSearch").fill("Product");
        await page.locator('#documentMoveOptions input[value="' + parent + '"]').check();
        await page.locator('#authoringDocumentDialog [type="submit"]').click();
        await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      }
      if (width > 700) {
        const drop = async (target, fraction) => {
          await page.locator("#documentTreeStatus").waitFor({ state: "hidden" });
          await row(child).locator(".document-tree-handle").waitFor();
          await target.waitFor();
          const source = await row(child).locator(".document-tree-handle").boundingBox(),
            box = await target.boundingBox(),
            version = (await snapshot()).version;
          assert.ok(source && box);
          await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction, { steps: 12 });
          await page.mouse.up();
          await waitFor(
            async () => (await snapshot()).version > version && (await page.locator("#documentTreeStatus").isHidden()),
          );
        };
        await drop(row(other), 0.1);
        let roots = (await snapshot()).nodes
          .filter((n) => n.parentId === null)
          .sort((a, b) => a.position - b.position)
          .map((n) => n.documentId);
        assert.deepEqual(roots, [parent, child, other]);
        await drop(row(other), 0.9);
        roots = (await snapshot()).nodes
          .filter((n) => n.parentId === null)
          .sort((a, b) => a.position - b.position)
          .map((n) => n.documentId);
        assert.deepEqual(roots, [parent, other, child]);
        await drop(row(parent), 0.5);
        await drop(page.locator(".document-tree-root"), 0.5);
        assert.equal((await snapshot()).nodes.find((n) => n.documentId === child).parentId, null);
        await drop(row(parent), 0.5);
        assert.equal((await snapshot()).nodes.find((n) => n.documentId === child).parentId, parent);
        assert.deepEqual(await api("/api/documents/detail?id=" + child), original);
      }
      await page.screenshot({ path: out + "/" + engine.name() + "-" + width + "-tree.png" });
      await menu(parent, "trash");
      assert.match(await page.locator("#authoringDocumentDialog").innerText(), /2/);
      await page.locator('#authoringDocumentDialog [type="submit"].danger').click();
      await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      assert.equal(
        (await snapshot()).nodes.some((n) => n.documentId === child),
        false,
      );
      await directory();
      await page.locator(".document-workspace-more summary").click();
      await page.locator('[data-authoring-action="trash"]').click();
      await page.locator('[data-trash-restore="' + parent + '"]').click();
      await page.locator("#documentReadTitle").waitFor();
      assert.deepEqual(await api("/api/documents/detail?id=" + child), original);
      await directory();
      await row(child).waitFor();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      await directory();
      await row(child).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      if (width > 700) {
        const renames = [];
        let loseRename = true;
        await page.route("**/api/project-document-tree/actions", async (route) => {
          renames.push(route.request().postDataJSON());
          const result = await route.fetch();
          if (loseRename) {
            loseRename = false;
            await route.abort("connectionreset");
          } else await route.fulfill({ response: result });
        });
        await menu(parent, "rename");
        await page.locator("#doc-title").fill("Recovered handbook");
        await page.locator('#authoringDocumentDialog [type="submit"]').click();
        await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
        await page.locator('[data-authoring-action="retry-tree"]:visible').click();
        await page.locator("#documentTreeStatus").waitFor({ state: "hidden" });
        assert.deepEqual(renames[1], renames[0]);
        assert.equal(await page.locator("#documentReadTitle").innerText(), "Recovered handbook");
        await page.unroute("**/api/project-document-tree/actions");
        const count = (await snapshot()).nodes.length,
          commands = [];
        let dropReply = true;
        await page.route("**/api/project-document-tree/documents", async (route) => {
          commands.push(route.request().postDataJSON());
          const result = await route.fetch();
          if (dropReply) {
            dropReply = false;
            await route.abort("connectionreset");
          } else await route.fulfill({ response: result });
        });
        await page.locator('[data-authoring-action="new"]:visible').click();
        await page.locator('[data-authoring-action="retry-tree"]:visible').waitFor();
        assert.equal((await snapshot()).nodes.length, count + 1);
        assert.equal(await page.locator('[data-authoring-action="new"]:visible').isDisabled(), true);
        await page.reload();
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator('[data-authoring-action="retry-tree"]:visible').click();
        await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
        assert.deepEqual(commands[1], commands[0]);
        assert.equal((await snapshot()).nodes.length, count + 1);
        assert.equal(await page.locator("#documentTreeStatus").isHidden(), true);
      }
      assert.deepEqual(errors, []);
      assert.doesNotMatch(await page.locator(".project-document-authoring").innerText(), /documents\.[a-zA-Z]+/);
      checks.push({
        engine: engine.name(),
        width,
        locale,
        nativeTouch,
        manualChild: true,
        sourcePreserved: true,
        logicalRename: true,
        searchAndKeyboard: true,
        move: true,
        subtreeTrashRestore: true,
        reload: true,
        selectedRenameThenSave: width > 700,
        lostReplyReloadReplay: width > 700,
        dragCancelThenMenu: width > 700,
        beforeAfterRootDrop: width > 700,
        uncertainFormExposesRecovery: width > 700,
        liveLocaleSwitchPreservesEditorAndSearch: true,
      });
      console.log(
        engine.name() + " " + width + ": document nodes, editor lifetime, move, search and subtree recovery passed",
      );
    } catch (error) {
      await page.screenshot({ path: out + "/" + engine.name() + "-" + width + "-failure.png" }).catch(() => {});
      await writeFile(out + "/failure.txt", String(error.stack || error));
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify(checks, null, 2));
} finally {
  await app.dispose();
}
