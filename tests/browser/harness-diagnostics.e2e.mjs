import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_HARNESS_DIAGNOSTICS_PROOF || ".artifacts/harness-diagnostics-browser";
await mkdir(output, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  extraEnvironment: ({ dir }) => {
    const profiles = [false, true].map((rejectSession) => {
      const home = join(dir, rejectSession ? "bad-account" : "account");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({ fixture: { access_token: "fixture-only", rejectSession } }),
      );
      return {
        id: rejectSession ? "grok-bad" : "grok-local",
        name: rejectSession ? "Expired account" : "Grok Build",
        command: new URL("../support/grok-acp-fixture.mjs", import.meta.url).pathname,
        accountHome: home,
      };
    });
    return { PANDA_FORCE_HARNESS_PROFILES: JSON.stringify(profiles) };
  },
});
const records = [];
try {
  for (const engine of [chromium, webkit])
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const width = engine === chromium ? 1440 : 390,
        browser = await engine.launch(),
        context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      try {
        await app.signIn(context);
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", "aurora");
          }
        }, locale);
        const page = await context.newPage(),
          errors = [],
          requests = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.url().endsWith("/grok-local/ping")) requests.push(request.postDataJSON());
        });
        page.setDefaultTimeout(20000);
        await page.goto(app.base + "/settings/agent");
        const ping = () => page.locator('[data-harness-ping="grok-local"]');
        await ping().waitFor();
        let delay = true;
        await page.route("**/api/harness-runtimes/grok-local/ping", async (route) => {
          if (delay) await new Promise((resolve) => setTimeout(resolve, 700));
          await route.continue();
        });
        await ping().press("Enter");
        assert(await ping().isDisabled());
        await ping().evaluate((button) => {
          button.click();
          button.click();
        });
        await page.locator(".harness-ping-result").filter({ hasText: "Grok fixture reply completed." }).waitFor();
        assert.equal(requests.length, 1);
        assert.equal(await ping().evaluate((button) => document.activeElement === button), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        const before = await (await context.request.get(app.base + "/api/personal/harness/conversations")).json();
        assert.equal(before.conversations.length, records.length);
        await page.screenshot({ path: `${output}/ping-${locale}-${width}.png` });
        delay = false;

        if (locale === "en") {
          await page.unroute("**/api/harness-runtimes/grok-local/ping");
          let drop = true;
          await page.route("**/api/harness-runtimes/grok-local/ping", async (route) => {
            if (drop) {
              drop = false;
              await route.fetch();
              await route.abort("failed");
            } else await route.continue();
          });
          await ping().click();
          await page.getByRole("button", { name: /Get test result/, exact: true }).waitFor();
          assert.equal(await page.locator(".harness-ping-result").count(), 0);
          await ping().click();
          await page.getByRole("button", { name: /Test again/, exact: true }).waitFor();
          assert.equal(requests.at(-1).requestId, requests.at(-2).requestId);
          await page.locator('[data-runtime-id="grok-bad"]').click();
          await page.locator("[data-harness-probe]").click();
          await page
            .locator(".harness-feedback")
            .filter({ hasText: /sign in/i })
            .waitFor();
          await page.locator("[data-harness-back]").click();
          await page.locator('[data-harness-ping="grok-bad"]').click();
          await page
            .locator(".harness-ping-result")
            .filter({ hasText: /sign in/i })
            .waitFor();
          await page.screenshot({ path: `${output}/authentication-${width}.png` });
        }
        await page.goto(app.base + "/new");
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="grok-local"]').click();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await page.locator("#prompt").fill("Hello from an ordinary conversation.");
        await page.locator("#sendButton").click();
        await page.getByText("Grok fixture reply completed.", { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        records.push({
          engine: engine.name(),
          width,
          locale,
          realSendThroughFixture: true,
          diagnosticsOutsideChat: true,
          keyboard: true,
          duplicateClick: true,
          errors,
        });
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log("Harness diagnostic and ordinary-message PC/H5 flows passed in all four locales.");
} finally {
  await app.dispose();
}
