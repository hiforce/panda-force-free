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
  out = ".artifacts/project-space-ai/browser",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    try {
      await f.signIn(context);
      const selection = await context.request.post(f.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: f.base },
      });
      assert(selection.ok());
      await context.addInitScript(() => {
        try {
          localStorage.setItem("panda-force-theme", "aurora");
        } catch {}
      });
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await context.request.get(f.base + path)
            : await context.request.post(f.base + path, { data });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const initial = await api("/api/projects"),
        catalog = await api("/api/projects", {
          name: "Rocky's Blog",
          code: "rocky-blog-" + width,
          description: "Thoughts, stories and ideas worth sharing.",
          revision: initial.revision,
        });
      const project = catalog.projects.find((p) => p.code === "rocky-blog-" + width),
        base = "/project?id=" + project.id;
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (e) => errors.push(e.message));
      let creationPosts = 0;
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/api/document-creations" && r.method() === "POST") creationPosts++;
      });
      await page.goto(f.base + base);
      await page.locator("[data-gd-suggestions]:visible").waitFor();
      assert.equal(await page.locator("[data-system-composer]").isVisible(), true);
      assert.equal(await page.locator("[data-creative-ai]").count(), 0);
      assert.equal(await page.locator("[data-creative-new].primary").count(), 0);
      assert.equal(await page.locator("[data-gd-start]").isEnabled(), true);
      assert.equal(creationPosts, 0);
      assert.equal(await page.locator(".project-content-toolbar").isVisible(), false);
      await page.screenshot({ path: `${out}/empty-${width}.png` });
      await page.locator('[data-gd-suggestion="article"]').click();
      assert.ok((await page.locator("#gadgetDocumentPrompt").inputValue()).length > 10);
      await page.locator("#gadgetDocumentPrompt").fill("Draft an introduction to this project for new readers.");
      await page.locator("[data-gd-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.locator("[data-skill-package][data-skill-id]").first().click();
      await picker.locator("[data-skill-browser-close]").last().click();
      await page.locator(".creative-skill-chip").waitFor();
      assert.equal(await page.locator(".creative-skill-chip .template-cover").count(), 1);
      const dialog = page.locator(".creation-dialog[open]");
      await page.screenshot({ path: `${out}/selected-${width}.png` });
      let dropped = false;
      await page.route("**/api/document-creations", async (route) => {
        if (route.request().method() !== "POST" || dropped) return route.continue();
        dropped = true;
        const r = await route.fetch();
        assert.equal(r.status(), 202);
        await route.abort("failed");
      });
      await page.locator("[data-gd-start]").click();
      await dialog.locator(".user-input-card").waitFor();
      assert.equal(
        await dialog.locator(".creation-compose").isVisible(),
        false,
        "Direct creation must not require a second brief submission",
      );
      assert.equal((await api("/api/document-creations?project=" + project.id)).tasks.length, 1);
      await dialog.locator(".user-input-option").first().click();
      await dialog.locator(".user-input-submit").click();
      await dialog.locator('[data-creation-action="open"]').waitFor();
      await page.screenshot({ path: `${out}/generated-${width}.png` });
      await dialog.locator("[data-creation-close]").click();
      await page.locator(".creative-card").waitFor();
      assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "");
      assert.equal(await page.locator(".creative-skill-chip").count(), 0);
      assert.equal(await page.locator("[data-system-composer]").isVisible(), true);
      assert.equal(await page.locator(".project-content-toolbar").isVisible(), true);
      await page.screenshot({ path: `${out}/content-${width}.png` });
      if (process.env.PANDA_FORCE_TEST_SCOPE === "composer") {
        assert.deepEqual(errors, []);
        records.push({
          width,
          locale,
          scope: "composer",
          directSubmission: true,
          uncertainSubmissionRecovered: true,
          draftAndSelectionUpdated: true,
          passed: true,
        });
        continue;
      }
      await page.locator(`.resource-project-tabs a[href="${base}&tab=documents"]`).click();
      await page.locator(".project-document-row").waitFor();
      assert.equal(await page.locator(".resource-project-tabs > *").count(), 4);
      const tree = await api("/api/project-document-tree?project=" + project.id),
        parent = tree.nodes[0].documentId;
      await api("/api/project-document-tree/documents", {
        id: randomUUID(),
        projectId: project.id,
        treeVersion: tree.version,
        title: "Draft notes",
        locale: "en",
        parentId: parent,
      });
      await page.reload();
      await page.locator(".project-document-row").nth(1).waitFor();
      await page.locator("[data-directory-toggle]").click();
      assert.equal(await page.locator(".project-document-row").count(), 1);
      await page.locator("[data-project-document-search]").fill("Draft notes");
      await page.locator(".project-document-row").nth(1).waitFor();
      await page.locator("[data-directory-open]").last().click();
      await page.locator(".document-rich-content").waitFor();
      await page.locator(`a[href="${base}&tab=documents"]:visible`).first().click();
      await page.locator("[data-project-document-search]").waitFor();
      assert.equal(await page.locator("[data-project-document-search]").inputValue(), "Draft notes");
      await page.locator("[data-project-document-search]").fill("");
      await page.screenshot({ path: `${out}/documents-${width}.png` });
      const snapshot = await api("/api/projects");
      await api("/api/projects/assign", {
        projectId: project.id,
        sessionIds: ["old-alpha", "old-beta"],
        revision: snapshot.revision,
      });
      await page.goto(f.base + base + "&tab=sessions");
      await page.locator(".project-sessions-view .wb-session-entry").nth(1).waitFor();
      assert.equal(await page.locator(".wb-project-detail").count(), 0);
      assert.equal(await page.locator(".resource-project-tabs > *").count(), 4);
      await page.locator("#projectSessionSearch").fill("alpha");
      assert.equal(await page.locator(".wb-session-entry").count(), 1);
      await page.locator("#projectSessionDirectory").selectOption(f.alpha);
      await page.locator(`.resource-project-tabs a[href="${base}"]`).click();
      await page.locator("[data-system-composer]").waitFor();
      await page.locator(`.resource-project-tabs a[href="${base}&tab=sessions"]`).click();
      assert.equal(await page.locator("#projectSessionSearch").inputValue(), "alpha");
      assert.equal(await page.locator("#projectSessionDirectory").inputValue(), f.alpha);
      await page.locator("#projectSessionSearch").fill("");
      await page.locator("#projectSessionDirectory").selectOption("*");
      await page.screenshot({ path: `${out}/sessions-${width}.png` });
      await page.locator(`.resource-project-tabs a[href="/publish?project=${project.id}"]`).click();
      await page.locator(".project-publish-view").waitFor();
      assert.equal(await page.locator("[data-creative-heading]").textContent(), project.name);
      assert.equal(await page.locator(".resource-project-tabs > *").count(), 4);
      await page.screenshot({ path: `${out}/publish-${width}.png` });
      await page.locator('[data-publish-channel="x"]').click();
      await page.locator("[data-publish-new]").waitFor();
      assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
      assert.equal(await page.locator("[data-publish-project]").count(), 0);
      await page.locator(".resource-back").click();
      assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
      for (const language of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), language);
        await page.waitForFunction((value) => document.documentElement.lang === value, language);
        if (await page.locator(`.resource-project-tabs a[href="${base}"]`).count())
          await page.locator(`.resource-project-tabs a[href="${base}"]`).click();
        await page
          .locator(
            `[data-gd-start][aria-label="${language === "en" ? "Start writing" : language === "zh-CN" ? "开始创作" : "開始創作"}"]`,
          )
          .waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `${out}/content-${language}-${width}.png` });
      }
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        defaultAiComposer: true,
        manualSecondary: true,
        directSkillPicker: true,
        optionsPreserveDraft: true,
        oneSubmissionWithLostAcknowledgement: true,
        noSecondCreationForm: true,
        emptyAndPopulatedReviewed: true,
        allFourProjectSections: true,
        editorReturnsToDirectory: true,
        directorySearchAndCollapse: true,
        sessionFiltersPreserved: true,
        publishingKeepsProject: true,
        fourLocales: true,
        noHorizontalOverflow: true,
      });
    } catch (error) {
      const page = context.pages().at(-1);
      if (page) {
        await page.screenshot({ path: `${out}/failure-${width}.png` });
        await writeFile(`${out}/failure-${width}.html`, await page.content());
      }
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/results.json",
    JSON.stringify({ passed: true, records, productionModelCalls: false }, null, 2),
  );
} finally {
  await f.dispose();
}
