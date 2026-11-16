import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const f = await createAppFixture({
    applicationCreation: true,
    models: [
      {
        id: "gpt-fixture",
        model: "gpt-fixture",
        isDefault: true,
        displayName: "Fixture model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  }),
  out = ".artifacts/legacy-project-workspace",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await f.signIn(context);
      await context.addInitScript(() => {
        try {
          localStorage.setItem("panda-force-theme", "aurora");
        } catch {}
      });
      const catalog = f.legacyProject({ code: "legacy-review-" + width, name: "Existing documents " + width });
      const project = catalog.projects.find((p) => p.code === "legacy-review-" + width).id;
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await context.request.get(f.base + path)
            : await context.request.post(f.base + path, { data });
        assert.equal(r.ok(), true, await r.text());
        return r.json();
      };
      const tree = await api("/api/project-document-tree?project=" + project);
      const created = await api("/api/project-document-tree/documents", {
        id: randomUUID(),
        projectId: project,
        treeVersion: tree.version,
        title: "Preserved release notes",
        locale: "en",
        parentId: null,
      });
      assert.ok(created.operation.documentId);
      assert.deepEqual(await api("/api/creative-assets/capabilities?project=" + project), {
        contribute: true,
      });
      assert.deepEqual(await api("/api/creative-assets?project=" + project), { assets: [], nextCursor: null });
      assert.equal((await context.request.get(f.base + "/api/creative-assets?project=missing-project")).status(), 404);
      const p = await context.newPage(),
        errors = [];
      p.on("pageerror", (error) => errors.push(error.message));
      await p.goto(f.base + "/project?id=" + project);
      await p.locator("[data-creative-heading]").filter({ hasText: "Existing documents" }).waitFor();
      await p.locator("[data-creative-import]:enabled").waitFor();
      assert.equal(await p.locator("[data-creative-retry]").isVisible(), false);
      assert.equal(await p.locator("[data-system-composer]").isVisible(), true);
      for (const filter of ["web", "slides", "trash"])
        assert.equal(await p.locator(`[data-creative-filter="${filter}"]`).isVisible(), true);
      assert.equal(await p.locator("[data-system-composer]").isVisible(), true);
      await p.locator("#gadgetDocumentPrompt").fill("Draft a practical project handbook.");
      assert.equal(await p.locator("#gadgetDocumentPrompt").inputValue(), "Draft a practical project handbook.");
      await p.locator("[data-gd-start]").click();
      const dialog = p.locator(".creation-dialog[open]");
      const question = dialog.locator(".user-input-card");
      await question.waitFor();
      await question.locator(".user-input-option").first().click();
      await question.locator(".user-input-submit").click();
      await dialog.locator('[data-creation-action="open"]').waitFor();
      const tasks = (await api("/api/document-creations?project=" + project)).tasks;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].state, "succeeded");
      assert.ok(tasks[0].artifact.documentId);
      await dialog.locator("[data-creation-close]").click();
      const importQuery = new URLSearchParams({
        project,
        id: "c-" + randomUUID(),
        operationId: randomUUID(),
        kind: "web",
        title: "Imported project overview",
        name: "index.html",
        locale: "en",
      });
      const imported = await context.request.post(f.base + "/api/creative-assets/import?" + importQuery, {
        data: Buffer.from("<html><body><h1>Project overview</h1></body></html>"),
        headers: { "content-type": "application/octet-stream" },
      });
      assert.equal(imported.status(), 201, await imported.text());
      await p.reload();
      await p.locator(".creative-card").nth(2).waitFor();
      await p.locator("[data-creative-import]:enabled").waitFor();
      assert.equal(await p.locator("[data-creative-new]").isEnabled(), true);
      await p.locator(".creative-card").filter({ hasText: "Preserved release notes" }).waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await p.screenshot({ path: `${out}/project-${width}.png` });
      await p.locator("[data-creative-new]").click();
      await p.locator("#documentTitle").waitFor();
      await p.goto(f.base + "/project?id=" + project);
      await p.locator(".creative-card").nth(3).waitFor();
      assert.equal((await api("/api/project-document-tree?project=" + project)).nodes.length, 3);
      await p.route("**/api/creative-assets?**", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "documents.unavailable" } }),
        }),
      );
      await p.reload();
      await p.locator("[data-creative-retry]").waitFor();
      await p.locator(".creative-card").filter({ hasText: "Preserved release notes" }).waitFor();
      await p.unroute("**/api/creative-assets?**");
      await p.locator("[data-creative-retry]").click();
      await p.locator("[data-creative-retry]").waitFor({ state: "hidden" });
      await p.locator(".creative-card").nth(3).waitFor();
      assert.equal(await p.locator(".creative-card").count(), 4);
      for (const language of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        await p.evaluate((value) => window.__pandaForceI18n.setPreference(value), language);
        await p.waitForFunction((value) => document.documentElement.lang === value, language);
        await p
          .locator(
            `[data-gd-start][aria-label="${language === "en" ? "Start writing" : language === "zh-CN" ? "开始创作" : "開始創作"}"]`,
          )
          .waitFor();
        await p.locator(".creative-card").nth(3).waitFor();
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await p.screenshot({ path: `${out}/project-${language}-${width}.png` });
      }
      const after = await api("/api/project-document-tree?project=" + project);
      assert.equal(
        after.nodes.find((n) => n.documentId === created.operation.documentId).document.title,
        "Preserved release notes",
      );
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        legacyDocumentsPreserved: true,
        manualCreatePersists: true,
        nativeImportAndAiCreationSupported: true,
        defaultComposerPreservesDraft: true,
        realFailuresVisibleAndRetryable: true,
        noHorizontalOverflow: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await f.dispose();
}
