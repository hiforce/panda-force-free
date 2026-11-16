import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";

const out = ".artifacts/extension-settings/screens",
  records = [];
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 320, "zh-CN"],
]) {
  const app = await createAppFixture(),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let first = true,
    fail = false;
  try {
    await app.signIn(context);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/document-packages", async (route) => {
      if (route.request().method() === "GET") {
        if (first) {
          first = false;
          await held;
        }
        if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.continue();
    });
    await page.goto(app.base + "/settings/plugins-settings");
    await page.locator(".extension-loading").waitFor();
    assert.equal(await page.locator(".extension-empty").count(), 0);
    assert.equal(await page.locator("[data-extension-refresh]").isDisabled(), true);
    release();
    await page.locator(".extension-empty").waitFor();
    assert.equal(await page.locator(".extension-steps li").count(), 3);
    assert.equal(await page.locator('.extension-destination[href="/skills/writing"]').count(), 1);
    assert.equal(await page.locator('.extension-destination[href="/publish"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const gutter = await page
      .locator(".extension-workspace")
      .evaluate((el) => ({ x: el.getBoundingClientRect().left, gap: getComputedStyle(el).rowGap }));
    assert.equal(gutter.gap, "32px");
    await page.screenshot({ path: out + "/empty-" + width + ".png" });
    await page.locator('[data-extension-manage=""]').click();
    const dialog = page.locator("#settingsExtensionManager[open]");
    await page.waitForFunction(
      () => document.querySelector("#settingsExtensionManager")?.getAttribute("aria-busy") === "false",
    );
    const value = exampleThemePackage();
    await dialog
      .locator("#packageFile")
      .setInputFiles({ name: "theme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
    await dialog.locator('[data-package-action="review"]').click();
    await dialog.locator("#packageAccept").check();
    await dialog.locator('#packageApproval [type="submit"]').click();
    await dialog.locator(".package-version").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#settingsExtensionManager")?.getAttribute("aria-busy") === "false",
    );
    await page.keyboard.press("Escape");
    await page.locator(".extension-package").waitFor();
    assert.equal(await page.locator(".extension-package").count(), 1);
    assert.match(
      await page.locator(".extension-package").innerText(),
      locale === "en" ? /2 site themes/ : /2 个站点主题/,
    );
    await page.locator(".extension-package [data-extension-manage]").focus();
    await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
    await page.waitForFunction(() => document.querySelector(".extension-package h3")?.textContent === "Studio");
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-extension-manage")), true);
    await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
    await page.waitForFunction(() => document.querySelector(".extension-package h3")?.textContent === "示例主题");
    fail = true;
    await page.locator("[data-extension-refresh]").click();
    await page.locator("[data-extension-notice]:visible").waitFor();
    assert.equal(await page.locator(".extension-package").count(), 1);
    fail = false;
    await page.locator("[data-extension-refresh]").click();
    await page.locator("[data-extension-notice]").waitFor({ state: "hidden" });
    await page.locator(".extension-package [data-extension-manage]").click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-package-identity") === "example.studio",
    );
    await dialog.locator('[data-package-action="disable"]').click();
    await page.waitForFunction(
      () => document.querySelector("#settingsExtensionManager")?.getAttribute("aria-busy") === "false",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".extension-state")?.textContent.includes("停用"));
    await page.screenshot({ path: out + "/installed-" + width + ".png" });
    await page.locator('.extension-destination[href="/skills/writing"]').click();
    await page.waitForURL("**/skills/writing");
    assert.deepEqual(errors, []);
    records.push({ width, locale, result: "passed", gutter });
  } finally {
    release();
    await context.close();
    await browser.close();
    await app.dispose();
  }
}
await writeFile(".artifacts/extension-settings/verification.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
