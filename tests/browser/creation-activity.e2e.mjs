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
      await page.locator("#modelButton").click();
      const modelDialog = page.locator("#sessionSettingsDialog[open]");
      await modelDialog.locator('input[name="session-effort"][value="high"]').check();
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
      if (width < 1081) await page.locator("#sessionInfoButton").click();
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
        await page.locator("#composerSkillControl button").click();
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
      const carouselSeeds = [];
      if (locale === "en")
        for (let index = 0; index < 6; index++) {
          const reply = await context.request.post(app.base + "/api/personal/document-creations", {
            headers: { Origin: app.base },
            data: {
              ...firstResponse.request().postDataJSON(),
              id: crypto.randomUUID(),
              prompt: [
                "Product launch plan",
                "Category field mapping",
                "Research brief",
                "Release checklist",
                "User interview outline",
                "Brand guidelines",
              ][index],
            },
          });
          assert.equal(reply.status(), 202, await reply.text());
          carouselSeeds.push((await reply.json()).task.id);
        }
      await page.locator(".creation-session-actions [data-creation-new]").click();
      await gallery.locator(".creation-discovery-card").first().waitFor();
      assert(!(await page.locator("#sessionInfoButton").isVisible()));
      await page.locator(".creation-session-recent [data-activity-task]").first().waitFor();
      const recent = page.locator(".creation-session-recent");
      assert.equal(await recent.locator(".creation-record-excerpt,.creation-record-destination").count(), 0);
      assert((await recent.locator("[data-activity-task]").count()) <= 8);
      assert(
        await recent
          .locator(".creation-record")
          .evaluateAll((cards) =>
            cards.every(
              (card) => card.getBoundingClientRect().height <= 96 && card.getBoundingClientRect().width <= 261,
            ),
          ),
        "Recent records should remain compact on PC and H5",
      );
      await recent.scrollIntoViewIfNeeded();
      const track = recent.locator(".horizontal-carousel-track");
      await track.waitFor();
      await waitFor(async () => track.evaluate((node) => node.scrollWidth > node.clientWidth + 1));
      const all = recent.locator("[data-activity-more]");
      if (await all.isVisible()) {
        const height = (await track.boundingBox()).height;
        await all.click();
        assert.equal(await all.getAttribute("aria-expanded"), "true");
        assert((await track.boundingBox()).height <= height + 1, "All records must remain a single carousel row");
        await all.click();
      }
      const arrows = recent.locator(".horizontal-carousel-controls button");
      await arrows.nth(1).click();
      await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) > 200);
      await arrows.nth(0).click();
      await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) < 2);
      if (locale === "en") {
        const box = await track.boundingBox();
        await page.mouse.move(box.x + 240, box.y + 25);
        await page.mouse.down();
        await page.mouse.move(box.x + 35, box.y + 25, { steps: 12 });
        await page.mouse.up();
        await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) > 100);
        assert.equal(new URL(page.url()).pathname, "/create", "Dragging must not open a creation record");
        await track.focus();
        await page.keyboard.press("Home");
        await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) < 2);
        const touch = await context.newCDPSession(page);
        await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: box.x + 350, y: box.y + 35 }],
        });
        for (let step = 1; step <= 12; step++) {
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: box.x + 350 - step * 20, y: box.y + 35 }],
          });
          await page.waitForTimeout(20);
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) > 100);
        await touch.detach();
      }
      await track.focus();
      await page.keyboard.press("Home");
      await waitFor(async () => (await track.evaluate((node) => node.scrollLeft)) < 2);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await page.screenshot({ path: `${out}/recent-${locale}-${width}.png` });
      await recent.screenshot({ path: `${out}/recent-compact-${locale}-${width}.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      for (const id of carouselSeeds) {
        const cancelled = await context.request.post(app.base + "/api/personal/document-creations/cancel", {
          headers: { Origin: app.base },
          data: { id },
        });
        assert.equal(cancelled.status(), 200, await cancelled.text());
      }
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
