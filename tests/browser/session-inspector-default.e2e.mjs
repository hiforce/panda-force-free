import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = process.env.PANDA_FORCE_INSPECTOR_SCREENSHOTS || ".artifacts/session-inspector-default",
  evidence = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-session-details-open", "true");
          localStorage.setItem("panda-force-locale", locale);
        }
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/task/old-alpha");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#sessionInfoButton").waitFor();
      assert.equal(await page.locator("#sessionInspector").isVisible(), false);
      assert.equal(await page.locator("#sessionInfoButton").getAttribute("aria-expanded"), "false");
      await page.locator("#prompt").fill("Preserve this draft while I inspect the conversation.");
      await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionInspector").waitFor();
      assert.equal(await page.locator("#sessionInfoButton").getAttribute("aria-expanded"), "true");
      await page.locator('[data-session-action="close"]').click();
      await page.locator("#sessionInspector").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#prompt").inputValue(), "Preserve this draft while I inspect the conversation.");
      await page.locator("#sessionInfoButton").focus();
      await page.keyboard.press("Enter");
      await page.locator("#sessionInspector").waitFor();
      await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-beta"));
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active?.id === "old-beta");
      assert.equal(await page.locator("#sessionInspector").isVisible(), false);
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#sessionInspector").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `closed-${locale}-${width}.png`) });
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        locale,
        ignoresLegacyOpenPreference: true,
        manualButtonAndKeyboard: true,
        newConversationClosed: true,
        reloadClosed: true,
        inputPreserved: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.dispose();
}
