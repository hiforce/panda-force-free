import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { launchOptions } from "./browser-runtime.mjs";
const status = { authMode: "idaas", authenticated: true, identity: { account: "demo" } };
let requests = 0;
const build = await Bun.build({
  entrypoints: [new URL("../src/client/auth-session.js", import.meta.url).pathname],
  target: "browser",
});
assert.ok(build.success, build.logs.join("\n"));
const sessionBundle = await build.outputs[0].text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/auth/status") {
      requests++;
      return Response.json(status);
    }
    if (path === "/session.js") return new Response(sessionBundle, { headers: { "content-type": "text/javascript" } });
    if (path === "/shared/auth-return-path.js")
      return new Response(readFileSync(new URL("../src/shared/auth-return-path.js", import.meta.url)), {
        headers: { "content-type": "text/javascript" },
      });
    return new Response(
      '<main>Workspace</main><script type="module">import{installPandaForceSession}from"/session.js";installPandaForceSession(' +
        JSON.stringify(status) +
        ");window.ready=true;</script>",
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser;
try {
  browser = await chromium.launch({ ...launchOptions(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const start = new Date("2026-11-04T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await page.goto(server.url.href);
  await page.waitForFunction(() => window.ready);
  await page.clock.fastForward(299999);
  assert.equal(requests, 0);
  const check = () => page.evaluate(() => globalThis.__pandaForceCheckAuth());
  await page.clock.fastForward(1);
  await check();
  assert.equal(requests, 1);
  await page.clock.fastForward(300000);
  await check();
  assert.equal(requests, 2);
  const hidden = () =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  const visible = () =>
    page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await hidden();
  await page.clock.fastForward(600000);
  assert.equal(requests, 2);
  await visible();
  await check();
  assert.equal(requests, 3);
  for (let i = 0; i < 5; i++) {
    await hidden();
    await visible();
  }
  await check();
  assert.equal(requests, 3);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    dispatchEvent(new Event("offline"));
  });
  await page.clock.fastForward(600000);
  assert.equal(requests, 3);
  await page.evaluate(() => {
    delete navigator.onLine;
    dispatchEvent(new Event("online"));
  });
  await check();
  assert.equal(requests, 4);
  assert.equal(await page.locator("#pandaSessionNotice").isVisible(), false);
  console.log("Browser five-minute polling, background/offline suspension and foreground deduplication passed.");
} finally {
  await browser?.close();
  server.stop(true);
}
