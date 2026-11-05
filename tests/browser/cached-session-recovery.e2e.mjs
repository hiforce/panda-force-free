import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const fixture = await createAppFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ locale: "en" });
  await fixture.signIn(context);
  const page = await context.newPage();
  await page.goto(fixture.base + "/task/late-history");
  await page.getByRole("heading", { name: "Session unavailable" }).waitFor();
  // Reproduce a late cache/history response after a superseded startup read failed.
  await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    api.mutations.set("active", { id: "late-history", cwd: "/tmp", turns: [] });
    api.syncTurnSnapshot({
      id: "recovered-turn",
      status: "completed",
      items: [{ id: "recovered-answer", type: "agentMessage", text: "Recovered conversation history" }],
    });
    api.notify("thread/status/changed", { threadId: "late-history", status: { type: "idle" } });
  });
  await page
    .locator("#conversation .message-text")
    .filter({ hasText: "Recovered conversation history" })
    .waitFor({ state: "visible" });
  assert.equal(await page.getByRole("heading", { name: "Session unavailable" }).isVisible(), false);
  console.log("Late cached conversation recovery clears an obsolete unavailable state.");
} finally {
  await browser?.close();
  await fixture.dispose();
}
