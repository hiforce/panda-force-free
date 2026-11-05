import assert from "node:assert/strict";
import { createBrowserFixture } from "./browser-runtime.mjs";

const fixture = await createBrowserFixture();
let browser;
const contrast = (foreground, background) => {
  const light = (value) =>
    value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        value /= 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = light(foreground),
    b = light(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
try {
  browser = await fixture.launchBrowser();
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.base + "/task/old-alpha");
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.evaluate(() => {
      const api = globalThis.__pandaForceDebug;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.state.transport = "sse";
      window.clickCount = 0;
      window.sendCalls = [];
      window.releaseSend = null;
      document.querySelector("#sendButton").addEventListener("click", () => window.clickCount++);
      const original = window.fetch;
      window.fetch = async (resource, options = {}) => {
        const url = new URL(typeof resource === "string" ? resource : resource.url, location.href);
        if (url.pathname !== "/api/rpc") return original(resource, options);
        const call = JSON.parse(options.body);
        if (["turn/start", "turn/steer", "turn/interrupt"].includes(call.method)) {
          window.sendCalls.push(call);
          await new Promise((resolve) => (window.releaseSend = resolve));
          return Response.json({
            type: "rpc/result",
            id: call.id,
            result: { turn: { id: "accepted-" + window.sendCalls.length }, turnId: call.params.expectedTurnId },
          });
        }
        if (call.method === "host/thread/history")
          return Response.json({ type: "rpc/error", id: call.id, error: "Unsupported method" });
        if (call.method === "thread/read")
          return Response.json({ type: "rpc/result", id: call.id, result: { thread: api.state.active } });
        return original(resource, options);
      };
    });
    const button = page.locator("#sendButton");
    for (const [index, from, to, method] of [
      [0, "completed", "completed", "turn/start"],
      [1, "completed", "inProgress", "turn/steer"],
      [2, "inProgress", "completed", "turn/start"],
    ]) {
      const text = `Single click ${scheme} ${index}`;
      await page.evaluate(
        ({ index, from }) =>
          globalThis.__pandaForceDebug.syncTurnSnapshot({ id: "refresh-" + index, status: from, items: [] }),
        { index, from },
      );
      await page.locator("#prompt").fill(text);
      const bounds = await button.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.evaluate(() => {
        window.iconBeforeClick = document.querySelector("#sendButton").firstElementChild;
      });
      await page.mouse.down();
      await page.evaluate(
        ({ index, to }) =>
          globalThis.__pandaForceDebug.syncTurnSnapshot({ id: "refresh-" + index, status: to, items: [] }),
        { index, to },
      );
      const sameIcon = await button.evaluate((node) => node.firstElementChild === window.iconBeforeClick);
      await page.mouse.up();
      assert.equal(
        await page.evaluate(() => window.clickCount),
        index * 2 + 1,
        "A background refresh must not swallow the first click",
      );
      if (from === to) assert.equal(sameIcon, true, "An unchanged submit mode must preserve its icon");
      await page.waitForFunction((count) => window.sendCalls.length === count, index + 1);
      const calls = await page.evaluate(() => window.sendCalls);
      assert.equal(calls[index].method, method);
      assert.equal(calls[index].params.input[0].text, text);
      await button.click();
      assert.equal(
        await page.evaluate(() => window.sendCalls.length),
        index + 1,
        "A pending acknowledgement must not duplicate input",
      );
      const colors = await button.evaluate((node) => ({
        foreground: getComputedStyle(node).color,
        background: getComputedStyle(node).backgroundColor,
      }));
      assert.ok(
        contrast(colors.foreground, colors.background) >= 4.5,
        `${scheme} hovered send button must keep a readable icon`,
      );
      await page.evaluate(() => window.releaseSend());
      await page.waitForFunction(() => document.querySelector('.user-turn[data-delivery="sending"]') === null);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Single-click delivery survives idle/active background refresh; duplicate input is blocked and Light/Dark hover contrast is readable.",
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
