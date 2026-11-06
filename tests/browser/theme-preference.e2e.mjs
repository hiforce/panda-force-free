import assert from "node:assert/strict";
import { chromium } from "playwright";
import { join } from "node:path";
import { root, launchOptions } from "../support/browser-runtime.mjs";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (["/style.css", "/workbench.css", "/appearance.css"].includes(path))
      return new Response(Bun.file(join(root, "public", path.slice(1))));
    if (/^\/client\/[a-z-]+\.js$/.test(path)) return new Response(Bun.file(join(root, "src", path.slice(1))));
    return new Response(
      '<!doctype html><html><head><meta name="theme-color"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/appearance.css"></head><body><select id="themeSelect"><option>system</option><option>light</option><option>dark</option><option>silk</option><option>aurora</option></select><main class="conversation-shell"><section class="conversation"><article class="user-turn"><div class="user-message">Please review these changes. 中文消息也应清晰可读。</div><button class="user-message-copy">Copy</button></article></section><form class="composer"><textarea>Continue this task</textarea><button class="send-button">Send</button></form></main><script type="module">import{applyThemePreference}from"/client/theme.js";applyThemePreference();matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>applyThemePreference());document.querySelector("#themeSelect").onchange=e=>applyThemePreference(e.target.value);window.ready=true;</script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
const luminance = (value) =>
  value
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
let browser;
const results = [];
try {
  browser = await chromium.launch({ ...launchOptions(), args: ["--no-sandbox"] });
  for (const system of ["light", "dark"])
    for (const preference of ["light", "dark", "system", "silk", "aurora"]) {
      const context = await browser.newContext({ colorScheme: system, viewport: { width: 1100, height: 700 } }),
        page = await context.newPage();
      await page.goto(server.url.href);
      await page.waitForFunction(() => window.ready);
      await page.locator("#themeSelect").selectOption(preference);
      const actual = preference === "system" ? system : ["dark", "aurora"].includes(preference) ? "dark" : "light";
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement),
          message = getComputedStyle(document.querySelector(".user-message")),
          send = getComputedStyle(document.querySelector(".send-button"));
        return {
          theme: document.documentElement.dataset.theme,
          appearance: document.documentElement.dataset.appearance,
          canvas: root.getPropertyValue("--pf-canvas").trim(),
          background: message.backgroundColor,
          text: message.color,
          buttonBackground: send.backgroundColor,
          buttonText: send.color,
        };
      });
      assert.equal(colors.theme, actual);
      assert.ok(contrast(colors.text, colors.background) >= 7, JSON.stringify(colors));
      assert.ok(contrast(colors.buttonText, colors.buttonBackground) >= 4.5, JSON.stringify(colors));
      if (actual === "light" && preference !== "silk") assert.equal(colors.canvas, "#fff");
      if (actual === "dark") assert.ok(luminance(colors.background) < 0.1);
      assert.equal(
        colors.appearance,
        preference === "system"
          ? system === "dark"
            ? "graphite"
            : "light"
          : preference === "dark"
            ? "graphite"
            : preference,
      );
      await page.reload();
      await page.waitForFunction(() => window.ready);
      assert.equal(await page.locator("html").getAttribute("data-theme"), actual);
      assert.equal(await page.locator("#themeSelect").inputValue(), preference);
      await page.emulateMedia({ colorScheme: system === "dark" ? "light" : "dark" });
      const afterSystemChange = preference === "system" ? (system === "dark" ? "light" : "dark") : actual;
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, afterSystemChange);
      results.push({ system, preference, theme: actual, messageContrast: contrast(colors.text, colors.background) });
      await context.close();
    }
  const page = await browser.newPage({ colorScheme: "dark" });
  await page.goto(server.url.href);
  await page.waitForFunction(() => window.ready);
  const state = await page.evaluate(async () => {
    document.querySelector("#themeSelect").remove();
    const { applyThemePreference, readThemePreference } = await import("/client/theme.js");
    const events = [];
    window.addEventListener("panda-force:appearance-changed", (event) => events.push(event.detail));
    applyThemePreference("silk");
    return { preference: readThemePreference(), theme: document.documentElement.dataset.theme, events };
  });
  assert.equal(state.preference, "silk");
  assert.equal(state.theme, "light");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].appearance, "silk");
  await page.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await browser?.close();
  server.stop(true);
}
