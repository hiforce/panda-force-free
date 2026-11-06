import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";

const fixture = await createBrowserFixture({ usageRollout: true });
const browser = await fixture.launchBrowser(launchOptions());
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async (target = page, id = "old-alpha") => {
    await target.goto(fixture.base + "/task/" + id);
    await target.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await target.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
  };
  const usage = page.locator("#sessionUsageView .session-usage-total strong");
  await open();
  await page.waitForFunction(
    () => document.querySelector("#sessionUsageView .session-usage-total strong")?.title === "14,000",
  );
  assert.equal(await usage.innerText(), "14K");
  const order = await page.evaluate(() => ({
    usage: document.querySelector("#sessionUsageSection").getBoundingClientRect().y,
    execution: document.querySelector("#sessionExecutionSection").getBoundingClientRect().y,
  }));
  assert.ok(order.usage < order.execution);
  await page.locator('#sessionInspector [data-session-action="usage"]').click();
  assert.match(await page.locator("#sessionUsageDialogContent").innerText(), /14,000/);
  assert.match(await page.locator("#sessionUsageDialogContent").innerText(), /5,000/);
  await page.keyboard.press("Escape");
  const timestamp = new Date().toISOString();
  const next = {
    total: { totalTokens: 20000, inputTokens: 16000, outputTokens: 4000, cachedInputTokens: 8000 },
    last: { totalTokens: 6000 },
    modelContextWindow: 200000,
  };
  appendFileSync(
    join(fixture.dir, "sessions", "usage.jsonl"),
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 20000,
            input_tokens: 16000,
            output_tokens: 4000,
            cached_input_tokens: 8000,
          },
          last_token_usage: { total_tokens: 6000 },
          model_context_window: 200000,
        },
      },
    }) + "\n",
  );
  await page.evaluate(
    ({ next, timestamp }) =>
      globalThis.__pandaForceDebug.notify("thread/tokenUsage/updated", {
        threadId: "old-alpha",
        tokenUsage: next,
        pandaReceivedAt: timestamp,
      }),
    { next, timestamp },
  );
  assert.equal(await usage.innerText(), "20K");
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("thread/tokenUsage/updated", {
      tokenUsage: { total: { totalTokens: 999999 } },
    }),
  );
  assert.equal(await usage.innerText(), "20K");
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector("#sessionUsageView .session-usage-total strong")?.title === "20,000",
  );
  const freshContext = await browser.newContext({ viewport: { width: 1861, height: 888 } });
  const fresh = await freshContext.newPage();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await open(fresh);
  await fresh.waitForFunction(
    () => document.querySelector("#sessionUsageView .session-usage-total strong")?.title === "20,000",
  );
  await open(page, "old-beta");
  assert.equal(await usage.innerText(), "—");
  await open(page);
  await page.waitForFunction(
    () => document.querySelector("#sessionUsageView .session-usage-total strong")?.title === "20,000",
  );
  await freshContext.close();
  assert.deepEqual(errors, []);
  console.log(
    "Usage restores before new events, survives reload and a fresh browser, isolates sessions and ignores unattributed events",
  );
} finally {
  await browser.close();
}
