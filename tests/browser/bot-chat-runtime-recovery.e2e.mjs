import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const model = {
  id: "gpt-fixture",
  model: "gpt-fixture",
  displayName: "GPT Fixture",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
};
const app = await createAppFixture({ applicationChat: true, startupTimeoutMs: 60000, models: [model] });
const out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-chat-runtime-recovery";
const records = [];
await mkdir(out, { recursive: true });
try {
  for (const [browserType, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1100, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await context.addInitScript((language) => localStorage.setItem("panda-force-locale", language), locale);
      await app.signIn(context);
      const created = await context.request.post(app.base + "/api/bots", {
        headers: { Origin: app.base },
        data: { name: "Runtime recovery Bot", code: "runtime-recovery-" + width },
      });
      assert.equal(created.status(), 201);
      const { bot } = await created.json();
      const chat = "/api/bots/" + bot.id + "/chat";
      const page = await context.newPage();
      let submissions = 0;
      await page.route("**" + chat, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        submissions++;
        if (submissions === 1) {
          return route.fulfill({ status: 409, json: { error: { code: "runtimeSelectionUnavailable" } } });
        }
        const accepted = await route.fetch({ headers: { ...(await route.request().allHeaders()), Origin: app.base } });
        assert.equal(accepted.status(), 202, await accepted.text());
        return route.abort();
      });
      await page.goto(app.base + "/bots/" + bot.id + "/chat");
      const input = page.locator("[data-message]");
      await input.fill("Preserve this draft until it is accepted.");
      const submit = page.locator(".bot-chat-composer [type=submit]");
      await submit.click();
      const { runtimeSelectionUnavailable: notice } = JSON.parse(
        await readFile(new URL("../../src/shared/i18n/locales/" + locale + "/bots.json", import.meta.url), "utf8"),
      );
      await page.getByText(notice, { exact: true }).waitFor();
      assert.equal(await input.inputValue(), "Preserve this draft until it is accepted.");
      assert.equal(await page.locator("[data-send-recovery]").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, locale + "-" + width + ".png") });
      await submit.click();
      await page.getByText("What shall we explore?", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector("[data-message]").value === "");
      const snapshot = await (await context.request.get(app.base + chat)).json();
      assert.equal(snapshot.messages.length, 2);
      assert.equal(submissions, 2);
      records.push({ locale, width, rejectedDraftRetained: true, lostAcknowledgmentRecovered: true });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "result.json"), JSON.stringify({ passed: true, records }));
} finally {
  await app.dispose();
}
