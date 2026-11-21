import { selectSessionModel, selectedSessionModel, selectSessionEffort } from "../support/composer-settings.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/composer-settings";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  applicationCreation: true,
  models: [
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
    },
    {
      id: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna with a long model display name",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    },
  ],
});
const records = [];
try {
  for (const [engine, width, height, locale, theme] of [
    [chromium, 1440, 1000, "en", "aurora"],
    [webkit, 390, 844, "zh-CN", "graphite"],
    [webkit, 320, 740, "zh-HK", "aurora"],
    [webkit, 430, 900, "zh-TW", "graphite"],
    [webkit, 844, 390, "en", "graphite"],
  ]) {
    const browser = await engine.launch();
    try {
      const mobile = engine === webkit;
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: mobile,
        isMobile: mobile,
        locale,
        ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
      });
      await context.addInitScript(
        ({ locale, theme }) => {
          if (!/^https?:$/.test(location.protocol)) return;
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
          localStorage.setItem("panda-force-permission-full-access", "true");
        },
        { locale, theme },
      );
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/new");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
      const draft = "Keep this unfinished request. " + locale;
      await page.locator("#prompt").fill(draft);
      const geometry = await page.locator("#composer").evaluate((root) => {
        const rect = (e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, radius: getComputedStyle(e).borderRadius };
        };
        const add = root.querySelector('[data-composer-control="add"]'),
          settings = root.querySelector("#composerSettingsButton"),
          send = root.querySelector("#sendButton"),
          summary = root.querySelector(".composer-setting-summary");
        return {
          add: rect(add),
          settings: rect(settings),
          send: rect(send),
          summaryVisible: getComputedStyle(summary).display !== "none",
          textHeight: summary.offsetHeight,
          textLineHeight: parseFloat(getComputedStyle(summary).lineHeight),
          visibleButtons: [...root.querySelectorAll(".composer-footer button")].filter((e) => e.getClientRects().length)
            .length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(geometry.visibleButtons, 4, JSON.stringify(geometry));
      assert(!geometry.overflow);
      assert(geometry.settings.x - geometry.add.right >= 24, JSON.stringify(geometry));
      for (const r of [geometry.add, geometry.settings, geometry.send]) {
        assert.equal(r.h, 44);
        assert.equal(r.radius, "12px");
        assert(Math.abs(r.y - geometry.send.y) < 1);
      }
      assert.equal(geometry.summaryVisible, !mobile);
      if (mobile) assert.equal(geometry.settings.w, 44);
      await page.locator("#composerSettingsButton").click();
      await page.locator("#composerSettingsMenu").waitFor();
      const rootBounds = await page.locator("#composerSettingsMenu").boundingBox();
      assert(rootBounds.x >= 0 && rootBounds.x + rootBounds.width <= width + 1);
      assert(rootBounds.y >= 0 && rootBounds.y + rootBounds.height <= height + 1);
      await page.screenshot({ path: `${out}/root-${locale}-${width}.png` });
      await page.locator('[data-composer-setting="model"]').click();
      await page.locator("#sessionSettingsDialog[open]").waitFor();
      await selectSessionModel(page, "gpt-5.6-luna");
      await selectSessionEffort(page, "high");
      await page.locator("[data-settings-back]").click();
      await page.locator("#composerSettingsMenu").waitFor();
      await page.locator('[data-composer-setting="permissions"]').click();
      await page.locator("#permissionMenu").waitFor();
      await page.locator('[data-permission-mode="full-access"]').click();
      await page.locator("#fullAccessDialog[open]").waitFor();
      await page.locator('#fullAccessDialog [value="cancel"]').click();
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "default");
      await page.locator("#composerSettingsButton").click();
      await page.keyboard.press("Escape");
      assert(await page.locator("#composerSettingsButton").evaluate((e) => document.activeElement === e));
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      await page.goto(app.base + "/task/old-alpha");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
      await page.locator("#prompt").fill(draft);
      const before = await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel);
      await page.locator("#composerSettingsButton").click();
      await page.locator('[data-composer-setting="model"]').click();
      await selectSessionModel(page, "gpt-5.6-luna");
      await selectSessionEffort(page, "high");
      await page.locator("[data-settings-back]").click();
      await page.locator("#composerSettingsMenu").waitFor();
      await page.locator('[data-composer-setting="model"]').click();
      assert.equal(await selectedSessionModel(page), "gpt-5.6-luna");
      await page.locator("#sessionSettingsDialog [data-settings-dismiss]").first().click();
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), before);
      await page.locator("#composerSettingsButton").click();
      await page.locator('[data-composer-setting="model"]').click();
      await selectSessionModel(page, "gpt-5.6-luna");
      await page.locator('#sessionSettingsDialog button[type="submit"]').click();
      await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-luna");
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      await page.screenshot({ path: `${out}/toolbar-${locale}-${width}.png` });
      await page.locator("#composerSettingsButton").click();
      await page.locator('[data-composer-setting="permissions"]').click();
      await page.locator('input[name="session-permission"][value="full-access"]').check();
      await page.locator('#sessionSettingsDialog button[type="submit"]').click();
      await page.locator("#fullAccessDialog[open]").waitFor();
      await page.locator('#fullAccessDialog [value="cancel"]').click();
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "default");
      await page.goto(app.base + "/create");
      await page.locator('.creation-skill-discovery [data-skill-id="software-prd"]:enabled').waitFor();
      await page.locator("#composerSettingsButton").click();
      assert(await page.locator('[data-composer-setting="permissions"]').isDisabled());
      await page.locator('[data-composer-setting="model"]').click();
      await page.locator("#sessionSettingsDialog[open]").waitFor();
      await selectSessionModel(page, "gpt-5.6-sol");
      await selectSessionEffort(page, "high");
      await page.screenshot({ path: `${out}/creation-model-${locale}-${width}.png` });
      await page.locator('#sessionSettingsDialog button[type="submit"]').click();
      assert.equal(
        await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel),
        "gpt-5.6-luna",
        "Creation settings cannot overwrite the native session model",
      );
      await page.locator("#composerSettingsButton").click();
      await page.locator("#composerSettingsMenu .session-menu-close").click();
      assert(await page.locator("#composerSettingsButton").evaluate((e) => document.activeElement === e));
      assert.deepEqual(errors, []);
      records.push({
        width,
        height,
        locale,
        theme,
        geometry,
        nativeConfirmationPreserved: true,
        activeCancelAndBackPreserveDraft: true,
        creationSettingsSeparate: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, contexts: records.length }));
} finally {
  await app.dispose();
}
