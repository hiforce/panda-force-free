import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = process.env.PANDA_ORIGINAL_LIFECYCLE_PROOF || ".artifacts/original-storage-lifecycle",
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
      await context.addInitScript((locale) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const id = crypto.randomUUID();
      const registered = await context.request.post(app.base + "/api/system/storage-connections", {
        headers: { Origin: app.base },
        data: {
          id,
          name: "Connection " + locale,
          provider: "s3",
          bucket: "retained-draft",
          region: "us-east-1",
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
        },
      });
      assert.equal(registered.status(), 200);
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
      await field("profileId").selectOption(id);
      await panel.locator('[data-storage-kind="slides"]').check();
      held = new Promise((r) => (release = r));
      await panel.locator('[data-storage-action="reload"]').click();
      await switchPage("users");
      release();
      held = null;
      await page.locator("[data-users-notice]").waitFor();
      assert.equal(await page.locator(".original-storage-settings:visible").count(), 0);
      await switchPage("storage");
      await field("profileId").waitFor();
      assert.equal(await field("profileId").inputValue(), id);
      assert(await panel.locator('[data-storage-kind="slides"]').isChecked());
      assert.equal(await panel.locator('[type="password"]').count(), 0);
      assert.equal(writes, 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/${locale}-${width}.png` });
      results.push({ locale, width, draftRetained: true, credentialsAbsent: true, lateReadIgnored: true, writes });
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/result.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await app.dispose();
}
