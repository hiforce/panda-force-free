import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/composer-add-menu";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ applicationCreation: true });
const records = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 430, "zh-CN", "aurora"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "silk"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 932 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      const api = async (path, data, method = data ? "POST" : "GET") => {
        const response = await context.request.fetch(app.base + path, {
          method,
          headers: { Origin: app.base },
          ...(data ? { data } : {}),
        });
        assert(response.ok(), path + ": " + response.status() + " " + (await response.text()));
        return response.json();
      };
      await api("/api/system/database/selection", { driver: "sqlite" });
      const catalog = await api("/api/projects"),
        project = (
          await api("/api/projects", {
            name: "Context materials",
            code: "materials-" + locale.toLowerCase(),
            revision: catalog.revision,
          })
        ).projects.find((p) => p.code === "materials-" + locale.toLowerCase());
      const tree = await api("/api/project-document-tree?project=" + project.id),
        created = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title: "Original material",
          locale: "en",
          parentId: null,
        });
      const id = created.operation.documentId,
        query = new URLSearchParams({ project: project.id, id });
      const opened = await api("/api/project-documents/editor?" + query);
      const working = {
        title: "Original material",
        locale: "en",
        content: "# Pinned material\n\nThe selected document version.\n",
        resources: [],
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "The selected document version." }] }],
          },
        },
      };
      const savedDraft = await api(
        "/api/project-documents/editor?" + query,
        {
          operationId: crypto.randomUUID(),
          version: opened.draft.version,
          baseRevisionId: opened.draft.baseRevisionId,
          working,
        },
        "PUT",
      );
      const saved = await api("/api/project-documents/checkpoints?" + query, {
        operationId: crypto.randomUUID(),
        draftVersion: savedDraft.receipt.version,
        revisionId: opened.saved.revision.id,
      });
      await context.addInitScript(
        ({ locale, theme }) => {
          if (location.protocol.startsWith("http")) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/new?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const plus = page.locator('[data-composer-control="add"]'),
        menu = page.locator(".composer-add-menu[open]");
      await page.locator("#prompt").fill("Keep this message draft");
      assert.equal(
        await page.locator("#composer [data-session-skills]").count(),
        0,
        "One add entry in the shared toolbar",
      );
      await plus.click();
      await menu.waitFor();
      assert.equal(await menu.locator("[data-add-upload]").count(), 3);
      assert.equal(await page.locator("dialog[open]").count(), 1);
      await page.screenshot({ path: `${out}/menu-${locale}-${width}.png` });
      const geometry = await menu.evaluate((dialog) => {
        const r = dialog.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          right: r.right,
          left: r.left,
          height: innerHeight,
          overflow: dialog.scrollWidth > dialog.clientWidth + 1,
          reachable: [...dialog.querySelectorAll("button")]
            .filter((n) => n.getClientRects().length)
            .every((n) => {
              const b = n.getBoundingClientRect();
              return b.top >= r.top && b.bottom <= r.bottom + 1;
            }),
        };
      });
      assert(!geometry.overflow && geometry.reachable && geometry.top >= 0 && geometry.bottom <= geometry.height + 1);
      const camera = page.waitForEvent("filechooser");
      await menu.locator('[data-add-upload="camera"]').click();
      const cameraChooser = await camera;
      assert.equal(await page.locator("#attachmentInput").getAttribute("capture"), "environment");
      assert.equal(await page.locator("#attachmentInput").getAttribute("accept"), "image/*");
      assert(!cameraChooser.isMultiple());
      await cameraChooser.setFiles([]);
      await plus.click();
      const photos = page.waitForEvent("filechooser");
      await menu.locator('[data-add-upload="photos"]').click();
      const photoChooser = await photos;
      assert.equal(await page.locator("#attachmentInput").getAttribute("capture"), null);
      assert(photoChooser.isMultiple());
      await photoChooser.setFiles({
        name: "reference.png",
        mimeType: "image/png",
        buffer: await readFile("public/assets/panda-icon.png"),
      });
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.composerAttachments[0]?.status === "ready");
      await plus.click();
      await menu.locator("[data-session-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      assert.equal(await page.locator("dialog[open]").count(), 1, "Material and skill sheets do not stack");
      await picker.locator('[data-skill-id="software-prd"]').click();
      await picker.locator('[data-skill-id="meeting-notes"]').click();
      const rows = await picker
        .locator(".creation-skill-option")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
      assert(rows.length >= 3 && rows.every((height) => height >= 44 && height <= 76));
      assert.equal(await picker.locator('[aria-pressed="true"][data-skill-action="add"]').count(), 2);
      await page.screenshot({ path: `${out}/skills-${locale}-${width}.png` });
      if (locale === "en") {
        await page.evaluate(() => window.__pandaForceI18n.setPreference("zh-TW"));
        await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
        assert.match(await picker.locator("h2").innerText(), /加入技能/);
        assert.match(await picker.locator("[data-skill-search]").getAttribute("placeholder"), /名稱|關鍵/);
        assert.match(await picker.locator("[data-skill-categories] button").first().innerText(), /全部/);
        await page.evaluate(() => window.__pandaForceI18n.setPreference("en"));
        await page.waitForFunction(() => document.documentElement.lang === "en");
      }
      if (width < 768) {
        await page.setViewportSize({ width, height: 500 });
        await page.waitForFunction(() => {
          const r = document.querySelector(".creation-skill-browser[open]").getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight + 1;
        });
        const footer = await picker.locator(".creation-skill-browser-footer").boundingBox();
        assert(footer.y + footer.height <= 501);
        await page.screenshot({ path: `${out}/skills-short-${locale}-${width}.png` });
        await page.setViewportSize({ width, height: 932 });
      }
      await page.keyboard.press("Escape");
      assert(await plus.evaluate((node) => node === document.activeElement));
      assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 2);
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this message draft");
      await plus.click();
      await menu.locator("[data-add-documents]").click();
      const row = menu.locator("[data-add-document]").filter({ hasText: "Original material" });
      await row.waitFor();
      assert.equal(
        await menu.locator("[data-add-space]").isVisible(),
        false,
        "Saved file documents span project spaces",
      );
      await page.screenshot({ path: `${out}/documents-${locale}-${width}.png` });
      // The list binds the selected saved revision even if another editor creates a newer one.
      const latest = await api("/api/project-documents/editor?" + query);
      const changed = await api(
        "/api/project-documents/editor?" + query,
        {
          operationId: crypto.randomUUID(),
          version: latest.draft.version,
          baseRevisionId: latest.draft.baseRevisionId,
          working: {
            ...working,
            body: {
              ...working.body,
              document: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "A newer document version" }] }],
              },
            },
          },
        },
        "PUT",
      );
      await api("/api/project-documents/checkpoints?" + query, {
        operationId: crypto.randomUUID(),
        draftVersion: changed.receipt.version,
        revisionId: latest.saved.revision.id,
      });
      await row.click();
      await page.waitForFunction(
        () =>
          globalThis.__pandaForceDebug.state.composerAttachments.length === 2 &&
          globalThis.__pandaForceDebug.state.composerAttachments.every((a) => a.status === "ready"),
      );
      const attachment = await page.evaluate(() =>
        globalThis.__pandaForceDebug.state.composerAttachments.find((a) => a.name === "Original material.md"),
      );
      assert.equal(await readFile(attachment.path, "utf8"), saved.detail.revision.content);
      await page.screenshot({ path: `${out}/composer-${locale}-${width}.png` });
      await plus.click();
      const other = locale === "en" ? "zh-TW" : "en";
      await page.evaluate((locale) => window.__pandaForceI18n.setPreference(locale), other);
      await page.waitForFunction((locale) => document.documentElement.lang === locale, other);
      assert.match(await menu.locator("h2").innerText(), other === "en" ? /Add to message/ : /加入對話/);
      await page.keyboard.press("Escape");
      if (locale === "en") {
        let fail = true;
        await page.route("**/api/content-sources?*", (route) =>
          fail
            ? ((fail = false), route.fulfill({ status: 503, json: { messageId: "documents.unavailable" } }))
            : route.continue(),
        );
        await plus.click();
        await menu.locator("[data-add-documents]").click();
        await menu.locator("[data-add-retry]:visible").click();
        await menu.locator("[data-add-document]").filter({ hasText: "Original material" }).waitFor();
        await page.unroute("**/api/content-sources?*");
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        await page.route("**/api/project-documents/revisions?*", async (route) => {
          await gate;
          await route.continue();
        });
        const upload = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/attachments" && r.request().method() === "POST",
        );
        await menu.locator("[data-add-document]").filter({ hasText: "Original material" }).click();
        await page.waitForFunction(() =>
          globalThis.__pandaForceDebug.state.composerAttachments.some((a) => a.status === "uploading"),
        );
        await page.evaluate(() => globalThis.__pandaForceDebug.workbench.navigate("/task/old-beta"));
        await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active?.id === "old-beta");
        release();
        await upload;
        assert.equal(
          await page.locator("#composerAttachments .composer-attachment").count(),
          0,
          "Late document reads do not attach to another task",
        );
        await page.evaluate((project) => globalThis.__pandaForceDebug.startNewTask({ projectId: project }), project.id);
        await page.waitForFunction(
          () =>
            globalThis.__pandaForceDebug.state.composerAttachments.length === 3 &&
            globalThis.__pandaForceDebug.state.composerAttachments.every((a) => a.status === "ready"),
        );
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this message draft");
        await page.unroute("**/api/project-documents/revisions?*");
        await plus.click();
        await menu.locator("[data-add-documents]").click();
        await menu.locator("[data-add-document]").filter({ hasText: "Original material" }).waitFor();
        await page.route("**/api/project-documents/revisions?*", (route) =>
          route.fulfill({ status: 404, json: { messageId: "documents.notFound" } }),
        );
        await menu.locator("[data-add-document]").filter({ hasText: "Original material" }).click();
        await page.locator('.composer-attachment[data-status="failed"]').waitFor();
        assert(await page.locator("#sendButton").isDisabled());
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this message draft");
        await page.locator('.composer-attachment[data-status="failed"] .composer-attachment-remove').click();
        assert(await page.locator("#sendButton").isEnabled());
        await page.unroute("**/api/project-documents/revisions?*");
        const denied = await (
          await browser.newContext()
        ).request.get(app.base + "/api/project-documents/revisions?" + query + "&revision=" + saved.detail.revision.id);
        assert([401, 403].includes(denied.status()));
        const legacy = app
          .legacyProject({ name: "Legacy materials", code: "legacy-materials" })
          .projects.find((p) => p.code === "legacy-materials");
        const legacyDoc = await api("/api/project-documents", {
          projectId: legacy.id,
          title: "Legacy context",
          locale: "en",
        });
        await api(
          "/api/documents/detail?id=" + legacyDoc.document.id,
          { revision: legacyDoc.document.revision, title: "Legacy context", locale: "en", body: working.body },
          "PUT",
        );
        await page.goto(app.base + "/new?project=" + legacy.id);
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await plus.click();
        await menu.locator("[data-add-documents]").click();
        await menu.locator("[data-add-document]").filter({ hasText: "Legacy context" }).waitFor();
        assert(await menu.locator("[data-add-space]").isVisible());
        await page.evaluate(() => window.__pandaForceI18n.setPreference("en"));
        await page.waitForFunction(() => document.documentElement.lang === "en");
        assert.equal(await menu.locator("[data-add-status]").innerText(), "");
        assert.equal(await menu.locator("[data-add-space] option:checked").innerText(), "Project documents");
        await menu.locator("[data-add-document]").filter({ hasText: "Legacy context" }).click();
        await page.waitForFunction(() =>
          globalThis.__pandaForceDebug.state.composerAttachments.some(
            (a) => a.name === "Legacy context.md" && a.status === "ready",
          ),
        );
        await page.evaluate(() => globalThis.__pandaForceDebug.workbench.navigate("/create"));
        await page.locator("#composer:visible").waitFor();
        await page.locator("#prompt").fill("Create from these materials");
        await plus.click();
        const choose = page.waitForEvent("filechooser"),
          creationUpload = page.waitForResponse(
            (r) => new URL(r.url()).pathname === "/api/creation-materials" && r.request().method() === "POST",
          );
        await menu.locator('[data-add-upload="files"]').click();
        await (
          await choose
        ).setFiles({
          name: "creation-notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Creation material context"),
        });
        assert((await creationUpload).ok());
        await page.waitForFunction(() =>
          globalThis.__pandaForceDebug.state.composerAttachments.some(
            (a) => a.name === "creation-notes.txt" && a.status === "ready",
          ),
        );
        await plus.click();
        await menu.locator("[data-session-skills]").click();
        await picker.locator('[data-skill-id="meeting-notes"]').click();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#prompt").inputValue(), "Create from these materials");
      }
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        fileSource: true,
        pinnedSnapshot: true,
        uploadModes: true,
        denseMultiselect: true,
        geometry,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/report.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, contexts: records.length }));
} finally {
  await app.dispose();
}
