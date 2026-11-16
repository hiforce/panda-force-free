import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-composer";
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
const results = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1440, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      await context.addInitScript((locale) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      let options = 0,
        submissions = 0,
        destinationReads = 0,
        destinationFailure = 503;
      await page.route("**/api/creative-assets/capabilities?*", async (route) => {
        destinationReads++;
        if (destinationFailure) {
          await route.fulfill({
            status: destinationFailure,
            json: { messageId: destinationFailure === 404 ? "documents.notFound" : "documents.unavailable" },
          });
        } else await route.continue();
      });
      page.on("request", (r) => {
        if (r.url().includes("/document-creations/options")) options++;
        if (r.method() === "POST" && /\/document-creations$/.test(new URL(r.url()).pathname)) submissions++;
      });
      await page.goto(app.base + "/");
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.locator("[data-gd-skills]:enabled").waitFor();
      assert.equal(destinationReads, 0, "Typing and choosing skills must not wait for document services");
      assert.equal(await page.locator("[data-gd-status]").isVisible(), false);
      await page.locator("#gadgetDocumentPrompt").fill("Write a precise product requirements document.");
      await page.locator("[data-gd-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.waitFor();
      assert.equal(await page.locator(".creation-dialog[open]").count(), 0);
      assert.equal(options, 0);
      assert.equal(submissions, 0);
      await picker.locator("[data-skill-id=software-prd]").click();
      await picker.locator(".creation-skill-browser-footer [data-skill-browser-close]").click();
      await page.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      await page.locator("[data-gd-project]").click();
      const destinations = page.locator(".gadget-document-destinations.floating-menu");
      await destinations.waitFor();
      const menuBounds = await destinations.boundingBox();
      assert(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width);
      await page.screenshot({ path: `${out}/destination-${locale}-${width}.png` });
      await page.keyboard.press("Escape");
      assert(await page.locator("[data-gd-project]").evaluate((n) => n === document.activeElement));
      await page.locator("[data-gd-project]").click();
      await page.locator("[data-gd-project]").click();
      assert.equal(await destinations.count(), 0, "Clicking the destination again closes its menu");
      assert.equal(destinationReads, 0);

      await page.locator("[data-gd-start]").click();
      await page.locator("[data-gd-retry]:visible").waitFor();
      assert.equal(options, 0);
      assert.equal(submissions, 0);
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Write a precise product requirements document.",
      );
      await page.locator("[data-gd-skills]").click();
      await picker.waitFor();
      await picker.locator(".creation-skill-browser-footer [data-skill-browser-close]").click();
      await page.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      destinationFailure = 404;
      await page.locator("[data-gd-retry]").click();
      await page.waitForFunction(
        () => document.querySelector("[data-gd-start]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await page.locator("[data-gd-retry]").isVisible(), false);
      assert.equal(await page.locator("[data-gd-skills]").isEnabled(), true);
      const unavailable = {
        en: "This project is unavailable. Choose another destination.",
        "zh-CN": "当前项目已不可用，请选择其他保存位置。",
        "zh-HK": "目前項目已不可用，請選擇其他儲存位置。",
        "zh-TW": "目前專案已無法使用，請選擇其他儲存位置。",
      };
      assert.equal(await page.locator("[data-gd-notice]").innerText(), unavailable[locale]);
      destinationFailure = 0;
      await page.screenshot({ path: `${out}/selected-${locale}-${width}.png` });
      await page.reload();
      await page.locator("[data-gd-skills]:enabled").waitFor();
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Write a precise product requirements document.",
      );
      await page.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      assert.equal(options, 0);
      assert.equal(submissions, 0);
      assert.equal(await page.locator("[data-gd-status]").isVisible(), false);
      if (locale === "en") {
        await page.locator("[data-gd-start]").click();
        await page.locator(".creation-dialog[open]").waitFor();
        await page.waitForTimeout(1500);
        await writeFile(
          out + "/submission-debug.json",
          JSON.stringify(
            { options, submissions, body: await page.locator(".creation-dialog[open]").innerText() },
            null,
            2,
          ),
        );
        await page.screenshot({ path: out + "/submission.png" });
        await page.waitForFunction(() => document.querySelector(".creation-dialog[open] [data-creation-state]"));
        await page.keyboard.press("Escape");
        assert.equal(submissions, 1);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({ locale, width, options, submissions, passed: true });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
