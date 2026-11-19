import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({ viewport: { width: 1100, height: 500 } });
try {
  await app.signIn(context);
  const api = async (code) => {
    const r = await context.request.post(app.base + "/api/bots", {
      data: { code, name: "Sidebar Panda " + code },
      headers: { Origin: app.base },
    });
    assert.ok(r.ok());
    return (await r.json()).bot;
  };
  const first = await api("first"),
    page = await context.newPage();
  let release, entered;
  const waiting = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  let held = false;
  await page.route("**/api/bots/navigation", async (route) => {
    if (!held) {
      held = true;
      const response = await route.fetch();
      entered();
      await waiting;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.goto(app.base + "/bots");
  await started;
  const newBot = await api("created-during-navigation");
  await page.evaluate(() => window.dispatchEvent(new Event("panda-bots-changed")));
  release();
  await page.locator(`[data-bot-shortcut="${newBot.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-bot-shortcut="${first.id}"]`).count(), 1);
  for (let i = 0; i < 14; i++) await api("extra-" + i);
  await page.evaluate(() => window.dispatchEvent(new Event("panda-bots-changed")));
  await page.waitForFunction(() => document.querySelectorAll("[data-bot-shortcut]").length === 16);
  const region = page.locator('.bot-sidebar-list > [role="list"]'),
    bounds = await region.boundingBox();
  assert.ok(bounds.height <= 101);
  const last = page.locator("[data-bot-shortcut]").last();
  await last.focus();
  await last.scrollIntoViewIfNeeded();
  assert.ok(await region.evaluate((n) => n.scrollTop > 0));
  await page.keyboard.press("Enter");
  await page.locator("[data-clear]:enabled").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log(
    JSON.stringify({ staleCatalogCannotReplaceCreatedBot: true, shortViewportScroll: true, keyboardDirectChat: true }),
  );
} finally {
  await context.close();
  await browser.close();
  await app.dispose();
}
