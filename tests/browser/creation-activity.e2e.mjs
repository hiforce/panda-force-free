import { openComposerSettings } from "../support/composer-settings.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

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
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    },
  ],
});
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [chromium, 1600, "zh-CN"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript(() => {
        if (window === top && /^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
      });
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/create");
      const gallery = page.locator(".creation-skill-discovery");
      await gallery.locator('.creation-discovery-card [data-skill-id="software-prd"]:enabled').waitFor();
      assert(!(await page.locator("#sessionInfoButton").isVisible()));
      assert(!(await page.locator("#sessionInspector").isVisible()));
      assert.equal(await page.locator("#composer").count(), 1);
      assert(await page.locator(".creation-entry-composer #composer").isVisible());
      await page.waitForTimeout(400);
      assert(
        await page.locator("#conversation").evaluate((node) => node.scrollTop < 2),
        "Discovery entry must stay at the top",
      );
      await page.screenshot({ path: `${out}/entry-${locale}-${width}.png` });
      await gallery.locator(".creation-discovery-cover img").first().scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".creation-discovery-cover img")].some(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      );
      await gallery
        .locator(".creation-discovery-cover img")
        .first()
        .evaluate((img) => img.decode());
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/gallery-${locale}-${width}.png` });
      await gallery.locator('[data-skill-id="software-prd"]').click();
      const skill = page.locator('#composerSkills [data-selected-skill="software-prd"]');
      assert(await skill.isVisible());
      await openComposerSettings(page, "model");
      const modelDialog = page.locator("#sessionSettingsDialog[open]");
      await modelDialog.locator('[name="session-runtime-model"]').selectOption("gpt-fixture");
      await modelDialog.locator('[name="session-runtime-effort"]').selectOption("high");
      await modelDialog.locator('button[type="submit"]').click();
      await modelDialog.waitFor({ state: "hidden" });
      const prompt = "Write a requirements document for a multi-channel product platform. " + locale;
      await page.locator("#prompt").fill(prompt);
      const submitted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/personal/document-creations") && response.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const firstResponse = await submitted;
      assert.equal(firstResponse.status(), 202, await firstResponse.text());
      const task = (await firstResponse.json()).task;
      assert.equal(firstResponse.request().postDataJSON().effort, "high");
      await page.waitForURL("**/creation/" + task.id + "?creationScope=personal");
      const question = page.locator(".creation-session-status .user-input-card");
      await question.waitFor();
      assert.equal(await page.locator(".creation-skill-discovery").count(), 0);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      await page
        .locator("#conversation .message-text")
        .filter({ hasText: "reviewing the requirements" })
        .first()
        .waitFor();
      if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionInspector").waitFor({ state: "visible" });
      const inspectorWidth = await page
        .locator("#sessionInspector")
        .evaluate((node) => node.getBoundingClientRect().width);
      assert(width < 1081 ? inspectorWidth <= width : inspectorWidth >= 280 && inspectorWidth <= 330);
      assert(await page.locator("#sessionDomainSections .creation-session-records").isVisible());
      assert(
        await page
          .locator("#sessionUsageSection")
          .evaluate((node) => node.nextElementSibling.id === "sessionDomainSections"),
      );
      await page.screenshot({ path: `${out}/inspector-${locale}-${width}.png` });
      if (width < 1081) await page.locator('#sessionInspector [data-session-action="close"]').click();
      if (locale === "en") {
        await page.locator('[data-composer-control="add"]').click();
        await page.locator(".composer-add-menu[open] [data-session-skills]").click();
        const picker = page.locator(".creation-skill-browser[open]");
        await picker.locator('[data-skill-category="research"]').click();
        await picker.locator('[data-skill-id="research-digest"]').click();
        await picker.locator("footer [data-skill-browser-close]").click();
        const uploaded = page.waitForResponse(
          (response) =>
            response.url().includes("/api/creation-materials?name=") && response.request().method() === "POST",
        );
        await page.locator("#attachmentInput").setInputFiles({
          name: "fields.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("field,required\nsize,true\n"),
        });
        assert.equal((await uploaded).status(), 201);
        await page.locator("#prompt").fill("Also include the supplied field mapping in the requirements.");
        const message = page.waitForResponse(
          (response) =>
            response.url().endsWith("/document-creations/message") && response.request().method() === "POST",
        );
        await page.locator("#sendButton").click();
        const accepted = await message;
        assert.equal(
          accepted.status(),
          202,
          (await accepted.text()) + " " + JSON.stringify(accepted.request().postDataJSON()),
        );
        assert.equal((await accepted.json()).task.id, task.id);
        assert.equal(accepted.request().postDataJSON().selections.length, 2);
        await page.locator("#conversation .user-message").filter({ hasText: "supplied field mapping" }).waitFor();
        await waitFor(() =>
          app
            .calls()
            .some(
              (call) =>
                call.method === "turn/steer" &&
                call.params.expectedTurnId &&
                call.params.input[0].text.includes("supplied field mapping"),
            ),
        );
        assert.equal(await page.locator("#composerAttachments .composer-attachment").count(), 0);
      }
      await question.locator(".user-input-option").first().click();
      await page.waitForTimeout(1700);
      assert(await question.locator('input[type="radio"]').first().isChecked());
      if (locale === "en") {
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
        assert(await question.locator('input[type="radio"]').first().isChecked());
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
      }
      await question.locator(".user-input-submit").click();
      await page.locator("[data-creation-open]:visible").waitFor();
      while (await page.locator('#composerSkills [data-skill-action="remove"]').count())
        await page.locator('#composerSkills [data-skill-action="remove"]').first().click();
      assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 0);
      await page.locator("#prompt").fill("Add clear acceptance criteria and access-control requirements.");
      await page.waitForTimeout(1600);
      assert.match(await page.locator("#prompt").inputValue(), /acceptance criteria/);
      if (locale === "en") {
        let dropped = false;
        await page.route("**/api/personal/document-creations/message", async (route) => {
          if (dropped) return route.continue();
          dropped = true;
          const accepted = await route.fetch();
          assert.equal(accepted.status(), 202);
          await route.abort("failed");
        });
        await page.locator("#sendButton").click();
        await page.locator(".creation-session-notice button").waitFor();
        await page.locator("#prompt").fill("Keep this new draft while recovering the previous submission.");
        await page.reload();
        await page.locator(".creation-session-notice button").waitFor();
        assert.match(await page.locator("#prompt").inputValue(), /new draft/);
        await page.locator(".creation-session-notice button").click();
      } else await page.locator("#sendButton").click();
      await page.waitForURL((url) => url.pathname.startsWith("/creation/") && !url.pathname.endsWith(task.id));
      await page.locator(".creation-session-status .user-input-card").waitFor();
      assert.equal(
        await page.locator("#composerSkills [data-selected-skill]").count(),
        0,
        "Removed skills must stay removed",
      );
      if (locale === "en") assert.match(await page.locator("#prompt").inputValue(), /new draft/);
      await page.screenshot({ path: `${out}/conversation-${locale}-${width}.png` });
      await page.locator(".creation-session-actions [data-creation-new]").click();
      await gallery.locator(".creation-discovery-card").first().waitFor();
      assert(!(await page.locator("#sessionInfoButton").isVisible()));
      assert.equal(await page.locator("#conversation [data-activity-list]").count(), 0);
      const firstCard = gallery.locator(".creation-discovery-card").first();
      const { inputMinimum, emptyInputHeight, firstCardHeight, firstCardBottom, coverWidth, viewportHeight } =
        await page.evaluate(() => {
          const bottom = (selector) => document.querySelector(selector).getBoundingClientRect();
          const input = document.querySelector("#prompt");
          return {
            inputMinimum: Number.parseFloat(getComputedStyle(input).minHeight),
            emptyInputHeight: input.value ? 0 : input.getBoundingClientRect().height,
            firstCardHeight: bottom(".creation-discovery-card").height,
            firstCardBottom: bottom(".creation-discovery-card").bottom,
            coverWidth: bottom(".creation-discovery-card .template-cover").width,
            viewportHeight: innerHeight,
          };
        });
      assert.equal(inputMinimum, 64);
      assert(emptyInputHeight <= 96);
      assert(firstCardHeight <= 144);
      assert(coverWidth >= 80);
      assert(firstCardBottom < viewportHeight, "Skills must be actionable on the first screen");
      await page.screenshot({ path: `${out}/home-${locale}-${width}.png` });
      await firstCard.locator(".creation-discovery-title").click();
      const detail = page.locator(".creation-skill-detail[open]");
      await detail.waitFor();
      assert((await detail.locator(".creation-skill-readme").innerText()).trim().length > 0);
      await page.keyboard.press("Escape");
      await detail.waitFor({ state: "hidden" });
      assert(
        await firstCard.locator("[data-skill-action=details]").evaluate((node) => document.activeElement === node),
      );
      await page.locator("[data-creation-history]").press("Enter");
      await page.locator(".creation-history-page [data-activity-task]").first().waitFor();
      await page.screenshot({ path: `${out}/history-${locale}-${width}.png` });
      await page.goBack();
      await firstCard.waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      records.push({ locale, width, inspectorWidth, actualRoute: true, errors });
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
