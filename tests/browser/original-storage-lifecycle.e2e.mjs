import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/original-storage-lifecycle",
  results = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width < 768,
        isMobile: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => localStorage.setItem("panda-force-locale", locale), locale);
      const page = await context.newPage();
      let writes = 0,
        held,
        release;
      await page.route("**/api/system/storage", async (route) => {
        if (route.request().method() !== "GET") {
          writes++;
          return route.continue();
        }
        if (held) {
          const wait = held;
          await wait;
        }
        await route.continue().catch(() => {});
      });
      const switchPage = async (id) => {
        const back = page
          .locator("#settingsMobileBack:visible, .settings-page:not([hidden]) .settings-mobile-back:visible")
          .first();
        if (await back.isVisible()) await back.click();
        const button = page.locator(`[data-settings-page="${id}"]`);
        if (!(await button.isVisible())) await button.locator("xpath=ancestor::details/summary").click();
        await button.click();
      };
      await page.goto(app.base + "/settings/storage");

      const panel = page.locator(".original-storage-settings"),
        field = (name) => panel.locator(`[data-storage-field="${name}"]`);
      await field("mode").selectOption("s3");
      await field("bucket").fill("retained-draft-" + locale);
      await field("secretAccessKey").fill("temporary-secret");
      held = new Promise((r) => (release = r));
      await panel.locator('[data-storage-action="reload"]').click();
      await switchPage("users");
      release();
      held = null;
      await page.locator("[data-users-notice]").waitFor();
      assert.equal(await page.locator(".original-storage-settings:visible").count(), 0);
      await switchPage("storage");
      await field("bucket").waitFor();
      assert.equal(await field("bucket").inputValue(), "retained-draft-" + locale);
      assert.equal(await field("secretAccessKey").inputValue(), "");
      assert.equal(writes, 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/${locale}-${width}.png` });
      results.push({ locale, width, draftRetained: true, secretsCleared: true, lateReadIgnored: true, writes });
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/result.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await app.dispose();
}
