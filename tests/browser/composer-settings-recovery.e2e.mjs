import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/composer-settings-recovery";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
const results = [];
try {
  for (const [engine, width, height] of [
    [chromium, 1280, 900],
    [webkit, 390, 844],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: engine === webkit,
        hasTouch: engine === webkit,
        ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
      });
      await context.addInitScript(() => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", "en");
      });
      await app.signIn(context);
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let mode = "ready",
        release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/model-catalog?runtimeId=*", async (route) => {
        if (mode === "fail")
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Catalog temporarily unavailable" }),
          });
        if (mode === "delay") await pending;
        await route.continue();
      });
      await page.goto(app.base + "/new");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
      const draft = "Retain this draft while settings recover.";
      await page.locator("#prompt").fill(draft);
      mode = "fail";
      await page.evaluate(async () => {
        const api = globalThis.__pandaForceDebug;
        api.mutations.set("models", []);
        await api.loadModels({ attempts: 1 });
      });
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.modelLoadStatus === "error");
      await page.locator("#composerSettingsButton").click();
      assert((await page.locator('[data-composer-setting="model"] small').innerText()).toLowerCase().includes("retry"));
      await page.locator('[data-composer-setting="model"]').click();
      await page.locator("#sessionSettingsDialog [data-runtime-retry]").waitFor();
      await page.locator("[data-settings-back]").click();
      await page.locator("#composerSettingsMenu").waitFor();
      await page.locator('[data-composer-setting="model"]').click();
      await page.locator("#sessionSettingsDialog [data-runtime-retry]").waitFor({ state: "visible" });
      mode = "delay";
      await page.locator("#sessionSettingsDialog [data-runtime-retry]").click();
      await page.locator('#sessionSettingsDialog [name="session-runtime-model"][aria-busy="true"]').waitFor();
      await page.keyboard.press("Escape");
      await page.locator("#composerSettingsButton").click();
      assert.equal(await page.locator("#composerSettingsButton").getAttribute("aria-busy"), "false");
      const titles = [];
      for (const locale of ["zh-CN", "zh-HK", "zh-TW", "en"]) {
        await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
        await page.locator("#composerSettingsMenu").waitFor();
        titles.push(await page.locator("#composerSettingsMenu h2").innerText());
        assert.equal(await page.locator("#prompt").inputValue(), draft);
      }
      assert.equal(titles[0], "对话设置");
      assert.equal(titles[1], "對話設定");
      assert.equal(titles[2], "對話設定");
      assert.equal(titles[3], "Conversation settings");
      mode = "ready";
      release();
      await page.evaluate(async () => globalThis.__pandaForceDebug.loadModels({ attempts: 1 }));
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.modelLoadStatus === "ready");
      assert.equal(await page.locator("#composerSettingsButton").getAttribute("aria-busy"), "false");
      await page.locator('[data-composer-setting="model"]').click();
      await page.locator('[name="session-runtime-effort"]').waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      await page.screenshot({ path: `${out}/recovered-${width}.png` });
      assert.deepEqual(errors, []);
      results.push({
        width,
        height,
        modelFailureAndRetry: true,
        delayedCatalogKeepsSettingsUsable: true,
        languageSwitches: titles,
        draftPreserved: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, contexts: results.length }));
} finally {
  await app.dispose();
}
