import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-activity";
await mkdir(out, { recursive: true });
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
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await context.addInitScript(() => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
      });
      await app.signIn(context);
      const db = await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      assert(db.ok());
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const historyReads = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/document-creations/detail") && !url.searchParams.has("view"))
          historyReads.push(url.href);
      });
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/workspace");
      await page.locator("[data-gd-skills]:enabled").waitFor();
      await page
        .locator("#gadgetDocumentPrompt")
        .fill(
          "Write a product requirements document for a multi-channel product operations platform. " +
            locale +
            " The platform maintains shared product data, adapts required fields and images for each destination, and supports reviewed publishing, price updates, content updates, permissions, retries and receipts.".repeat(
              4,
            ),
        );
      await page.locator("[data-gd-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.locator('[data-skill-id="software-prd"]:enabled').click();
      await picker.locator("footer [data-skill-browser-close]").click();
      await page.locator("[data-gd-start]").click();
      const progress = page.locator(".creation-dialog[open]");
      await progress.locator("[data-creation-task]").waitFor();
      const taskId = await progress.locator("[data-creation-task]").getAttribute("data-creation-task");
      await progress.locator("[data-creation-close]").click();
      const row = page.locator(`[data-activity-task="${taskId}"]`);
      await row.waitFor();
      await row.click();
      const detail = page.locator(".creation-detail-page");
      await detail.locator(".user-input-card").waitFor();
      assert.equal(historyReads.length, 0, "Opening progress must not load conversation history");
      await detail.locator('[data-detail-tab="conversation"]').click();
      await detail.locator('[data-conversation-role="user"]').first().waitFor();
      await detail.locator(".user-input-option").first().click();
      await page.waitForTimeout(2200);
      assert(await detail.locator('input[type="radio"]').first().isChecked());
      if (locale === "en") {
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
        await detail.locator("[data-detail-tab=conversation]").filter({ hasText: "创作对话" }).waitFor();
        assert(await detail.locator('input[type="radio"]').first().isChecked());
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
        await detail.locator("[data-detail-tab=conversation]").filter({ hasText: "Creation conversation" }).waitFor();
      }
      await detail.locator(".user-input-submit").click();
      await detail.locator("[data-detail-open]:visible").waitFor();
      assert.equal(await detail.locator('[data-creation-action="open"]').count(), 0);
      await detail.locator("textarea").fill("Add measurable acceptance criteria and access-control requirements.");
      await page.waitForTimeout(2200);
      assert.match(await detail.locator("textarea").inputValue(), /acceptance criteria/);
      if (locale === "en") {
        let dropped = false;
        await page.route("**/api/personal/document-creations/follow-up", async (route) => {
          if (dropped) return route.continue();
          dropped = true;
          const accepted = await route.fetch();
          assert.equal(accepted.status(), 202);
          await route.abort("failed");
        });
        await detail.locator("form.creation-follow-up button[type=submit]").click();
        await detail.locator("[data-follow-up-status]").filter({ hasText: "could not be confirmed" }).waitFor();
        assert(await detail.locator("textarea").evaluate((input) => input.readOnly));
        await page.reload();
        await page.locator(".creation-detail-page textarea:read-only").waitFor();
      }
      await page.screenshot({ path: `${out}/detail-${locale}-${width}.png` });
      await page.reload();
      await page.locator(".creation-detail-page textarea").waitFor();
      assert.match(await detail.locator("textarea").inputValue(), /acceptance criteria/);
      const followUp = page.waitForResponse(
        (response) =>
          response.url().endsWith("/document-creations/follow-up") && response.request().method() === "POST",
      );
      await detail.locator("form.creation-follow-up button[type=submit]").click();
      const submitted = await followUp;
      assert.equal(submitted.status(), 202, await submitted.text());
      const updated = (await submitted.json()).task;
      assert.equal(updated.previousTaskId, taskId);
      await detail.locator(".user-input-card").waitFor();
      await detail.locator(".user-input-option").first().click();
      await detail.locator(".user-input-submit").click();
      await detail.locator("[data-detail-open]:visible").waitFor();
      assert.equal(await detail.locator('[data-creation-action="open"]').count(), 0);
      await detail.locator('[data-detail-tab="conversation"]').click();
      await detail.locator("[data-conversation-round]").nth(1).waitFor();
      assert.equal(await detail.locator("[data-version]").count(), 2);
      assert.equal(await detail.locator("[data-conversation-round]").count(), 2);
      await page.goto(app.base + "/create");
      await page.locator(`[data-activity-task="${updated.id}"][data-state=succeeded]`).waitFor();
      await page.locator('[data-activity-filter="completed"]').click();
      await page.locator("[data-activity-search-toggle]").click();
      await page.locator("[data-activity-search]").fill(locale);
      assert(await page.locator(`[data-activity-task="${taskId}"]`).isVisible());
      await page.screenshot({ path: `${out}/list-${locale}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const sessions = await (
        await context.request.post(app.base + "/api/rpc", {
          data: { id: "creation-visibility", method: "thread/list", params: { limit: 100 } },
          headers: { Origin: app.base },
        })
      ).json();
      assert(!JSON.stringify(sessions).includes(".panda-force-creation/run-"));
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        selectedPrdSkill: true,
        originalAndUpdatedOutputs: true,
        workbenchAndCreateHistory: true,
        reloadAndDraftRecovery: true,
        questionInputSurvivesPolling: true,
        noOverflow: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.stop();
}
