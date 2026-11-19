import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture({
  applicationCreation: true,
  models: [
    {
      id: "gpt-slider",
      model: "gpt-slider",
      displayName: "Slider model",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["ultra", "medium", "low", "minimal", "high", "xhigh", "max"].map(
        (reasoningEffort) => ({ reasoningEffort }),
      ),
    },
    {
      id: "gpt-fixed",
      model: "gpt-fixed",
      displayName: "Fixed model",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    },
  ],
});
const out = ".artifacts/reasoning-slider/screens",
  results = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, height, locale] of [
    [chromium, 1440, 1000, "en"],
    [webkit, 390, 844, "zh-CN"],
    [webkit, 320, 740, "zh-HK"],
    [webkit, 430, 900, "zh-TW"],
    [webkit, 844, 390, "en"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        locale,
        isMobile: engine === webkit,
        hasTouch: engine === webkit,
        colorScheme: width < 768 ? "dark" : "light",
      });
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.base + "/new");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
      const expected = await page.evaluate(() =>
        Object.fromEntries(
          ["minimal", "low", "medium", "high", "extraHigh", "max", "ultra", "reasoningEffort"].map((id) => [
            id,
            globalThis.__pandaForceI18n.t("common." + id),
          ]),
        ),
      );
      await page.locator("#modelButton").click();
      assert.equal(await page.locator("#modelButton").getAttribute("aria-haspopup"), "dialog");
      assert.equal(await page.locator("#modelMenu").getAttribute("role"), "dialog");
      const range = page.locator('#modelMenu input[type="range"]');
      assert.equal(await range.getAttribute("max"), "6");
      assert.equal(await range.getAttribute("step"), "1");
      assert.equal(await range.inputValue(), "2");
      assert.equal(await range.getAttribute("aria-label"), expected.reasoningEffort);
      assert.equal(await range.getAttribute("aria-valuetext"), expected.medium);
      assert.deepEqual(
        await page.locator("#modelMenu .wb-range-ticks > span").evaluateAll((nodes) => nodes.map((n) => n.title)),
        [
          expected.minimal,
          expected.low,
          expected.medium,
          expected.high,
          expected.extraHigh,
          expected.max,
          expected.ultra,
        ],
      );
      const box = await range.boundingBox();
      assert(box.height >= 44);
      assert(
        await range.evaluate((e) => {
          const b = e.getBoundingClientRect();
          return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === e;
        }),
      );
      if (engine === webkit) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      else await range.click();
      assert.equal(await range.getAttribute("aria-valuetext"), expected.high);
      assert.equal(await page.locator("#effortSelect").inputValue(), "high");
      await range.press("End");
      assert.equal(await page.locator("#effortSelect").inputValue(), "ultra");
      assert.equal(await page.locator("#modelMenu output").innerText(), expected.ultra);
      await range.press("ArrowLeft");
      assert.equal(await page.locator("#effortSelect").inputValue(), "max");
      assert.equal(await page.locator("#modelMenu").isVisible(), true);
      const geometry = await page.locator("#modelMenu").boundingBox();
      const bottom = await page.locator(".workspace-attribution").boundingBox();
      const navigation = await page.locator(".workbench-mobile-nav").boundingBox();
      assert(geometry.y + geometry.height <= Math.min(bottom?.y ?? height, navigation?.y ?? height));
      assert(geometry.height < 260, "Seven discrete levels keep the menu compact");
      await page.screenshot({ path: `${out}/menu-${locale}-${width}.png` });
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#modelButton").evaluate((e) => e === document.activeElement), true);
      await page.locator("#modelButton").click();
      assert.equal(await range.getAttribute("aria-valuetext"), expected.max);
      await page.locator("#modelSubmenuButton").click();
      await page.locator('[data-model="gpt-fixed"]').click();
      await page.locator("#modelButton").click();
      assert.equal(await range.isDisabled(), true);
      assert.equal(await range.getAttribute("max"), "0");
      assert.equal(await range.getAttribute("aria-valuetext"), expected.high);
      await page.locator("#modelSubmenuButton").click();
      await page.locator('[data-model="gpt-slider"]').click();
      await page.locator("#modelButton").click();
      assert.equal(await range.getAttribute("aria-valuetext"), expected.max);
      await page.keyboard.press("Escape");

      const native = await context.newPage();
      native.on("pageerror", (e) => errors.push(e.message));
      await native.goto(app.base + "/task/old-alpha");
      await native.waitForFunction(
        () =>
          globalThis.__pandaForceDebug?.state.active?.id === "old-alpha" &&
          globalThis.__pandaForceDebug.state.modelLoadStatus === "ready",
      );
      if (width >= 1081) await native.locator("#sessionInfoButton").click();
      const before = await native.locator("#effortSelect").inputValue();
      await native.locator("#modelButton").click();
      const draft = native.locator('#sessionSettingEfforts input[type="range"]');
      await draft.press("Home");
      assert.equal(await draft.getAttribute("aria-valuetext"), expected.minimal);
      await native.locator("#sessionSettingsDialog [data-settings-dismiss]").first().click();
      assert.equal(await native.locator("#effortSelect").inputValue(), before, "Cancel preserves the saved effort");
      await native.locator("#modelButton").click();
      await draft.press("Home");
      await draft.press("ArrowRight");
      assert.equal(await draft.getAttribute("aria-valuetext"), expected.low);
      await native.screenshot({ path: `${out}/dialog-${locale}-${width}.png` });
      await native.locator('#sessionSettingsForm button[type="submit"]').click();
      await native.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
      assert.equal(await native.locator("#effortSelect").inputValue(), "low");
      const restored = await context.newPage();
      restored.on("pageerror", (e) => errors.push(e.message));
      await restored.goto(app.base + "/task/old-alpha");
      await restored.waitForFunction(
        () =>
          globalThis.__pandaForceDebug?.state.active?.id === "old-alpha" &&
          globalThis.__pandaForceDebug.state.modelLoadStatus === "ready",
      );
      assert.equal(
        await restored.locator("#effortSelect").inputValue(),
        "low",
        "Saved selection survives a fresh page",
      );
      const creation = await context.newPage();
      creation.on("pageerror", (e) => errors.push(e.message));
      await creation.goto(app.base + "/create");
      await creation.locator("#composerSkillControl button").waitFor();
      await creation.locator("#modelButton").click();
      const creationRange = creation.locator('#sessionSettingEfforts input[type="range"]');
      await creationRange.press("Home");
      await creationRange.press("ArrowRight");
      await creation.locator('#sessionSettingsForm button[type="submit"]').click();
      await creation.locator("#prompt").fill("Write requirements with acceptance criteria. " + locale);
      const submitted = creation.waitForResponse(
        (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
      );
      await creation.locator("#sendButton").click();
      const accepted = await submitted;
      assert.equal(accepted.status(), 202);
      assert.equal(accepted.request().postDataJSON().effort, "low", "The slider effort reaches the creation request");
      assert.equal(await creation.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({
        width,
        height,
        locale,
        compactMenu: true,
        keyboardAndPointer: true,
        fixedModel: true,
        saveCancel: true,
      });
      console.log(JSON.stringify({ checked: locale, width }));
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
