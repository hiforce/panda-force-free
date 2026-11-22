import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_HARNESS_USAGE_PROOF || ".artifacts/grok-usage-fix/browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  models: [{ id: "gpt-fixture", model: "gpt-fixture", displayName: "Fixture", isDefault: true }],
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "grok-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok One",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome: account,
        },
      ]),
    };
  },
});
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript((value) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", value);
      }, locale);
      await app.signIn(context);
      const api = async (path, data, method = data === undefined ? "GET" : "POST") => {
        const response = await context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/harness-runtimes", {
        name: "Grok Two " + locale,
        profileId: "grok-local",
        enabled: true,
        access: "administrators",
        defaultModel: null,
        defaultEffort: null,
      });
      const second = catalog.runtimes.find((entry) => entry.name === "Grok Two " + locale);
      const base = "/api/personal/harness/conversations";
      const { conversation } = await api(base, { runtimeId: "grok-local" });
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/task/" + encodeURIComponent("harness:" + conversation.id));
      const preparation = page.locator("#workspacePreparation");
      const ready = () =>
        preparation.waitFor({ state: "hidden" }).catch(async (error) => {
          throw new Error(`${locale} workspace preparation: ${await preparation.innerText()}`, { cause: error });
        });
      await ready();
      const path = base + "/" + conversation.id;
      const send = async (value, total) => {
        const sent = await api(path + "/runs", { requestId: crypto.randomUUID(), text: value });
        await waitFor(async () => {
          const snapshot = await api(path);
          if (snapshot.run?.id !== sent.runId || snapshot.conversation.activeRunId) return false;
          assert.equal(snapshot.run.status, "complete");
          assert.equal(snapshot.tokenUsage?.total.totalTokens, total);
          return true;
        });
      };
      const inspectUsage = async (total) => {
        const result = page.locator("#sessionUsageView .session-usage-total strong");
        try {
          await page.waitForFunction(
            (value) => document.querySelector("#sessionUsageView .session-usage-total strong")?.title === value,
            total,
            { timeout: 10000 },
          );
        } catch (error) {
          const current = await result.getAttribute("title", { timeout: 1000 }).catch(() => null);
          throw new Error(`${locale} usage expected ${total}, found ${current} at ${page.url()}`, { cause: error });
        }
      };
      await send("harness.token-usage", 2000);
      await inspectUsage("2,000");
      await page.locator("#harnessButton").click();
      await page.locator('[data-harness-select="' + second.id + '"]').click();
      await page.locator("#harnessMenu").waitFor({ state: "hidden" });
      assert.equal((await api(path)).conversation.runtimeId, second.id);
      await send("harness.token-usage", 4000);
      await inspectUsage("4,000");
      await page.reload();
      await ready();
      await inspectUsage("4,000");
      const button =
        width < 768
          ? page.locator('#sessionMobileSummary [data-session-action="usage"]')
          : page.locator('#sessionInspector [data-session-action="usage"]');
      if (width >= 768 && !(await button.isVisible())) await page.locator("#sessionInfoButton").click();
      await button.click();
      assert.match(await page.locator("#sessionUsageDialogContent").innerText(), /3,600/);
      assert.match(await page.locator("#sessionUsageDialogContent").innerText(), /1,400/);
      await page.screenshot({ path: join(out, locale + "-" + width + ".png") });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
