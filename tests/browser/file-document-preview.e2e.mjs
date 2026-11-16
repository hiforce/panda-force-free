import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture(),
  artifacts = ".artifacts/file-document-preview",
  checks = [];
await mkdir(artifacts, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
      await fixture.signIn(context);
      const api = async (path, data, method = "get") => {
        const response = await context.request[method](fixture.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const current = await api("/api/projects"),
        created = await api(
          "/api/projects",
          { code: "file-preview-" + width, name: "Document preview", revision: current.revision },
          "post",
        ),
        project = created.projects.find((p) => p.code === "file-preview-" + width);
      const catalog = new ProjectCatalog(join(fixture.dir, "panda-state/data/projects.sqlite"));
      try {
        assert.equal(new ProjectDocumentStorage(catalog.db).files(project.id), true);
      } finally {
        catalog.db.close();
      }
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      page.on("response", async (response) => {
        if (response.status() >= 400 && response.url().includes("/api/project-documents"))
          console.error("Preview API failure", response.status(), await response.text());
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-authoring-action="new"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      const id = new URL(page.url()).searchParams.get("document"),
        scope = new URLSearchParams({ project: project.id, id });
      await page.locator("#documentTitle").fill("");
      await page.waitForTimeout(1400);
      assert.equal(await page.locator('[data-doc-action="discard"]').isHidden(), true);
      await page.locator("#documentTitle").fill("Acceptance document " + width);
      await page
        .locator('.document-rich-content[contenteditable="true"]')
        .fill("A durable document with a clear reading and editing experience.");
      await waitFor(
        async () =>
          (await api("/api/project-documents/editor?" + scope)).working.title === "Acceptance document " + width,
      );
      let detail = await api("/api/project-documents/editor?" + scope);
      assert.equal(detail.saved.document.revision, 1);
      assert.equal(detail.draft.dirty, true);
      assert.equal(await page.locator('[data-doc-action="publishing"]').isDisabled(), true);
      await page.locator('.document-file-commands [data-doc-action="save"]').click();
      await waitFor(async () => (await api("/api/project-documents/editor?" + scope)).saved.document.revision === 2);
      await waitFor(async () => page.locator('[data-doc-action="publishing"]').isEnabled());
      const image = await sharp({ create: { width: 28, height: 20, channels: 4, background: "#4f46e5" } })
        .png()
        .toBuffer();
      await page
        .locator("[data-rich-image]")
        .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: image });
      await page.locator('.document-rich-content img[src*="/api/project-documents/assets/content"]').waitFor();
      await waitFor(async () => (await api("/api/project-documents/editor?" + scope)).draft.version >= 2);
      await page.locator('.document-file-commands [data-doc-action="save"]').click();
      await waitFor(async () => (await api("/api/project-documents/editor?" + scope)).saved.document.revision === 3);
      const source = await api("/api/project-documents/source?" + scope);
      assert.match(JSON.stringify(source.revision.body), /\/api\/document-assets\/content\?id=/);
      assert.doesNotMatch(JSON.stringify(source.revision.body), /project-documents\/assets/);
      const old = await context.request.get(fixture.base + "/api/documents/detail?id=" + id);
      assert.equal(old.status(), 404);
      await page.locator('[data-doc-action="preview"]').click();
      await page.reload();
      await page.locator("[data-document-reader] img").waitFor();
      assert.equal(
        await page.locator("[data-document-reader] img").evaluate((img) => img.complete && img.naturalWidth > 0),
        true,
      );
      await page.locator(".document-editor-more summary").click();
      await page.locator('[data-doc-action="history"]').click();
      await page.locator("#documentRevisionSelect").waitFor();
      const options = await page.locator("#documentRevisionSelect option").all();
      assert.equal(options.length, 3);
      const revision2 = (await api("/api/project-documents/revisions?" + scope)).revisions.find((r) => r.number === 2);
      await page.locator("#documentRevisionSelect").selectOption(revision2.id);
      await page.locator('#authoringDocumentDialog button[type="submit"]').click();
      await waitFor(async () => (await api("/api/project-documents/source?" + scope)).document.revision === 4);
      await page.reload();
      await page.locator("#documentReadTitle").waitFor();
      assert.match(await page.locator("#documentReadTitle").textContent(), /Acceptance document/);
      if (width < 700) await page.locator('[data-authoring-action="reader-edit"]').click();
      else await page.locator('[data-doc-action="edit"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      await page.locator("#documentTitle").fill("Acceptance document recovered " + width);
      await waitFor(
        async () =>
          (await api("/api/project-documents/editor?" + scope)).working.title ===
          "Acceptance document recovered " + width,
      );
      let lost = false;
      const loseCheckpoint = async (route) => {
        const response = await route.fetch();
        assert.ok(response.ok());
        lost = true;
        await route.abort("failed");
      };
      await page.route("**/api/project-documents/checkpoints?*", loseCheckpoint);
      await page.locator('.document-file-commands [data-doc-action="save"]').click();
      await waitFor(() => lost);
      await page.unroute("**/api/project-documents/checkpoints?*", loseCheckpoint);
      await page.locator('.document-file-commands [data-doc-action="retry"]').click();
      await waitFor(async () => (await api("/api/project-documents/source?" + scope)).document.revision === 5);
      await waitFor(async () => await page.locator('.document-file-commands [data-doc-action="retry"]').isHidden());
      const beforeConflict = await api("/api/project-documents/editor?" + scope);
      await api(
        "/api/project-documents/editor?" + scope,
        {
          operationId: crypto.randomUUID(),
          version: beforeConflict.draft.version,
          baseRevisionId: beforeConflict.saved.revision.id,
          working: { ...beforeConflict.working, title: "Remote draft" },
        },
        "put",
      );
      await page.locator("#documentTitle").fill("Local conflicting draft");
      await page.locator('[data-doc-action="discard"]').waitFor();
      assert.equal(await page.locator("#documentTitle").inputValue(), "Local conflicting draft");
      await page.locator('[data-doc-action="discard"]').click();
      await page.locator('#authoringDocumentDialog button[type="submit"]').click();
      await waitFor(async () => (await api("/api/project-documents/editor?" + scope)).draft.dirty === false);
      await page.locator('[data-doc-action="preview"]').click();
      if (width < 700) await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(`[data-tree-id="${id}"] .document-tree-more`).click();
      await page.locator('[data-node-command="new-child"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      const childId = new URL(page.url()).searchParams.get("document"),
        tree = await api("/api/project-document-tree?project=" + project.id);
      assert.equal(tree.nodes.find((n) => n.documentId === childId).parentId, id);
      await page.screenshot({ path: `${artifacts}/${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      checks.push({
        width,
        engine: engine === webkit ? "webkit" : "chromium",
        locale,
        workingCopy: true,
        checkpoints: true,
        imageRendering: true,
        canonicalImageSource: true,
        uncertainCheckpointReplay: true,
        conflictingDraftDiscard: true,
        legacyDenied: true,
        historyRestore: true,
        childDocuments: true,
        overflow: false,
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(artifacts + "/checks.json", JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  await fixture.dispose();
}
