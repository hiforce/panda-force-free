import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_ZCODE_PROGRESS_PROOF || ".artifacts/harness-zcode-progress";
await mkdir(out, { recursive: true });
const records = [];
for (const [engine, width, locale, thinking] of [
  [chromium, 1440, "en", "Thinking"],
  [webkit, 390, "zh-CN", "思考中"],
  [webkit, 390, "zh-HK", "思考中"],
  [webkit, 390, "zh-TW", "思考中"],
]) {
  let progressDirectory;
  const app = await createAppFixture({
    startupTimeoutMs: 60000,
    extraEnvironment: ({ dir }) => {
      progressDirectory = join(dir, "fixture-progress");
      mkdirSync(progressDirectory, { recursive: true });
      const providerConfig = join(dir, "zcode-provider.json");
      writeFileSync(providerConfig, JSON.stringify({ progressDirectory }));
      return {
        PANDA_FORCE_ZCODE_HARNESS_PROFILES: JSON.stringify([
          {
            id: "zcode-progress",
            name: "ZCode",
            command: new URL("../support/zcode-stdio-fixture.mjs", import.meta.url).pathname,
            builtinConfig: providerConfig,
            providerConfig,
            providerId: "fixture",
            model: "ZCode Progress Fixture",
          },
        ]),
      };
    },
  });
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await app.signIn(context);
    await context.addInitScript((locale) => {
      if (window === window.top && /^https?:$/.test(location.protocol))
        localStorage.setItem("panda-force-locale", locale);
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.base + "/new");
    await page.locator("#harnessButton").click();
    await page.locator('[data-harness-select="zcode-progress"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#composerSettingModel")?.textContent?.includes("ZCode Progress Fixture"),
    );
    await page.locator("#prompt").fill("Show progress before completing this fixture.");
    await page.locator("#sendButton").press("Enter");
    const indicator = page
      .locator("#conversation .reasoning-activity.active .activity-name")
      .filter({ hasText: thinking });
    await indicator.waitFor();
    assert.equal(await page.getByText("Fixture ZCode build active.", { exact: true }).count(), 0);
    await page.reload();
    await indicator.waitFor();
    await page.screenshot({ path: `${out}/thinking-${locale}-${width}.png`, scale: "css" });
    assert(progressDirectory);
    await writeFile(join(progressDirectory, "start-tool"), "");
    const tool = page.locator("#conversation .activity-item").filter({ hasText: "Read test file" });
    await tool.and(page.locator(".active")).waitFor();
    await indicator.waitFor({ state: "hidden" });
    await page.screenshot({ path: `${out}/tool-${locale}-${width}.png`, scale: "css" });
    await writeFile(join(progressDirectory, "complete-tool"), "");
    await tool.and(page.locator(".settled")).waitFor();
    assert.equal(await tool.count(), 1);
    await writeFile(join(progressDirectory, "answer"), "");
    await page.getByText("Fixture ZCode build active.", { exact: true }).waitFor();
    assert.equal(await page.getByText(/Private (reasoning|tool output) fixture|Stale tool fixture/).count(), 0);
    await waitFor(async () => (await page.locator("#conversation .reasoning-activity.active").count()) === 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    records.push({ locale, width, thinkingBeforeText: true, reload: true, toolSettledBeforeAnswer: true });
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
