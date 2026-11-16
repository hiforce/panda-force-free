import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const app = await createAppFixture({
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
});
const evidence = ".artifacts/document-creation-product";
await mkdir(evidence, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await app.signIn(context);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data });
        assert.ok(response.ok(), await response.text());
        return response.json();
      };
      const skill = await nativeSkillPackage("example.creation-skills-" + width);
      const review = await api("/api/skill-packs/review", {
        content: skill.content,
        name: "writing.skill.json",
        selected: ["blog-outline", "brand-voice"],
      });
      await api("/api/skill-packs/install", {
        content: skill.content,
        name: "writing.skill.json",
        approval: {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          capabilities: review.capabilities,
          selected: review.selected,
        },
      });
      const catalog = await api("/api/projects");
      const created = await api("/api/projects", {
        name: "Creation acceptance",
        code: "creation-" + width,
        revision: catalog.revision,
      });
      const project = created.projects.find((value) => value.code === "creation-" + width);
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const dialog = page.locator("#projectDocumentCreation");
      await page.locator('[data-authoring-action="new-ai"]:visible').first().click();
      await dialog.locator("[data-creation-submit]:enabled").waitFor();
      assert.equal(await dialog.locator(".creation-skill").count(), 0);
      await dialog.locator('[name="prompt"]').fill("Write a useful introductory handbook.");
      await dialog.locator("[data-creation-close]").click();
      await page.locator('[data-authoring-action="new-ai"]:visible').first().click();
      await dialog.locator("[data-creation-submit]:enabled").waitFor();
      assert.equal(await dialog.locator('[name="prompt"]').inputValue(), "Write a useful introductory handbook.");
      await dialog.locator("[data-skill-browser-open]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.locator(`[data-skill-package="${skill.pack.manifest.id}"][data-skill-id="blog-outline"]`).click();
      await picker.locator("[data-skill-browser-close]").last().click();
      await dialog.locator(".creation-skill-list .creation-skill").nth(0).locator("summary").click();
      await dialog.locator('[data-skill-parameter="audience"]').fill("New users");
      await dialog.locator("[data-skill-browser-open]").click();
      await picker.locator(`[data-skill-package="${skill.pack.manifest.id}"][data-skill-id="brand-voice"]`).click();
      await picker.locator("[data-skill-browser-close]").last().click();
      await dialog.locator('.creation-skill-list [data-skill-action="up"][data-index="1"]').click();
      assert.equal(await dialog.locator('[data-skill-parameter="audience"]').inputValue(), "New users");
      let accepted;
      await page.route("**/api/document-creations", async (route) => {
        if (route.request().method() !== "POST" || accepted) return route.continue();
        const input = route.request().postDataJSON();
        assert.deepEqual(
          input.selections.map((value) => value.id),
          ["brand-voice", "blog-outline"],
        );
        assert.equal(input.selections[1].parameters.audience, "New users");
        const response = await route.fetch();
        assert.equal(response.status(), 202);
        accepted = await response.json();
        await route.abort("failed");
      });
      await dialog.locator("[data-creation-submit]").click();
      await waitFor(() => accepted);
      const task = dialog.locator(`[data-creation-task="${accepted.task.id}"]`);
      await task.locator(".user-input-card").waitFor();
      assert.equal(await dialog.locator(".creation-skill").count(), 0);
      assert.equal(await dialog.locator('[name="prompt"]').inputValue(), "");
      assert.equal((await api("/api/document-creations?project=" + project.id)).tasks.length, 1);
      await task.locator(".user-input-option").first().click();
      await task.locator(".user-input-option").last().click();
      await task.locator(".user-input-custom").fill("A beginner who wants to learn by doing.");
      await page.waitForTimeout(2200);
      assert.equal(await task.locator(".user-input-custom").inputValue(), "A beginner who wants to learn by doing.");
      await page.screenshot({ path: `${evidence}/question-${width}.png` });
      await task.locator(".user-input-submit").click();
      await task.locator('[data-creation-action="open"]').waitFor();
      const saved = (await api("/api/document-creations/detail?id=" + accepted.task.id)).task;
      assert.equal(saved.state, "succeeded");
      assert.ok(saved.artifact.documentId);
      assert.equal(await dialog.locator(".user-input-card").count(), 0);
      await page.screenshot({ path: `${evidence}/result-${width}.png` });
      await task.locator('[data-creation-action="open"]').click();
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      assert.equal(new URL(page.url()).searchParams.get("document"), saved.artifact.documentId);
      assert.equal(await page.locator("#documentTitle").inputValue(), "Generated handbook");
      await page.locator(width < 700 ? '[data-authoring-action="reader-edit"]' : '[data-doc-action="edit"]').click();
      await page
        .locator('.document-rich-content[contenteditable="true"]')
        .fill("This generated document is now manually edited.");
      let releaseCheckpoint, checkpointStarted;
      const checkpointGate = new Promise((resolve) => (releaseCheckpoint = resolve)),
        checkpointRequest = new Promise((resolve) => (checkpointStarted = resolve));
      await page.route("**/api/project-documents/checkpoints?*", async (route) => {
        checkpointStarted();
        await checkpointGate;
        await route.continue();
      });
      const checkpointResponse = page.waitForResponse(
        (response) =>
          response.url().includes("/api/project-documents/checkpoints?") && response.request().method() === "POST",
      );
      await page.locator('[data-doc-action="save"]:enabled:visible').first().click();
      await checkpointRequest;
      assert.equal(await page.locator('[data-doc-action="save"]').first().isDisabled(), true);
      assert.equal(
        await page.locator("#documentSaveState").textContent(),
        locale === "en" ? "Saving draft…" : "正在保存草稿…",
      );
      releaseCheckpoint();
      const checkpoint = await checkpointResponse;
      assert.equal(checkpoint.status(), 200);
      assert.match((await checkpoint.json()).detail.revision.content, /manually edited/);
      await page.waitForFunction(
        (text) => document.querySelector("#documentSaveState")?.textContent === text,
        locale === "en" ? "Version saved" : "版本已保存",
      );
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      assert.match(await page.locator(".document-rich-content").innerText(), /manually edited/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${evidence}/editable-${width}.png` });
      console.log(
        `${engine.name()} ${width}: recovered brief, frozen workflow, ambiguous submission recovery, stable question selection, direct answer, actual file creation and manual editing passed`,
      );
      await context.close();
    } catch (error) {
      if (page) await page.screenshot({ path: `${evidence}/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
