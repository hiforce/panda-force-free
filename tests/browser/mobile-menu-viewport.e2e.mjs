import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
const out = ".artifacts/mobile-menu-viewport";
await mkdir(out, { recursive: true });
const app = await createBrowserFixture({ applicationCreation: true }),
  results = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const mobile = width < 768,
        height = 932,
        context = await browser.newContext({
          viewport: { width, height },
          locale,
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: "dark",
        });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (window !== top) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "dark");
        const native = window.visualViewport,
          viewport = new EventTarget();
        for (const key of ["height", "width", "scale", "offsetTop", "offsetLeft"])
          Object.defineProperty(viewport, key, { get: () => viewport["_" + key] ?? native[key] });
        Object.defineProperty(window, "visualViewport", { value: viewport });
        window.__menuViewport = viewport;
      }, locale);
      const page = await context.newPage(),
        errors = [],
        measurements = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      const aligned = async (label) => {
        await page.waitForFunction(
          ({ mobile, height }) => {
            const app = document.querySelector("#app").getBoundingClientRect(),
              nav = document.querySelector(".workbench-mobile-nav").getBoundingClientRect();
            return (
              Math.abs(app.height - height) < 1 &&
              (!mobile || Math.abs(nav.bottom - height) < 1) &&
              document.documentElement.scrollWidth <= innerWidth + 1
            );
          },
          { mobile, height },
        );
        if (mobile)
          await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
        measurements.push(
          await page.evaluate(
            (label) => ({
              label,
              path: location.pathname,
              height: document.querySelector("#app").getBoundingClientRect().height,
              navBottom: document.querySelector(".workbench-mobile-nav").getBoundingClientRect().bottom,
              visualHeight: visualViewport.height,
              css: document.documentElement.style.getPropertyValue("--app-viewport-height"),
            }),
            label,
          ),
        );
      };
      const sidebar = async (route) => {
        if (mobile) await page.locator("#workspaceNavigationToggle").click();
        await page.locator(`.workbench-navigation [data-route="${route}"]`).click();
        await page.waitForURL("**/" + route);
      };
      await page.goto(app.base + "/tasks");
      await page.locator("#workbenchView").waitFor();
      await aligned("cold tasks");
      await page.waitForTimeout(700);
      // Emulate WebKit retaining a dismissed keyboard measurement while the actual CSS viewport is already full height.
      await page.evaluate(() => {
        window.__menuViewport._height = 400;
        window.__menuViewport.dispatchEvent(new Event("resize"));
      });
      await sidebar("workspace");
      await aligned("sidebar to workspace with stale visual metrics");
      await page.locator("#gadgetDocumentPrompt").waitFor();
      await page.screenshot({ path: `${out}/workspace-${locale}-${width}.png` });
      if (mobile) await page.locator('.workbench-mobile-nav [data-route="create"]').click();
      else await sidebar("create");
      await page.waitForURL("**/create");
      await page.locator(".creation-skill-discovery").waitFor();
      await aligned("menu to create with stale visual metrics");
      await page.goBack();
      await page.waitForURL("**/workspace");
      await aligned("browser back");
      await page.goForward();
      await page.waitForURL("**/create");
      await aligned("browser forward");
      const draft = "Keep this draft through menu navigation and viewport recovery. " + locale;
      await page.locator("#prompt").fill(draft);
      if (mobile) {
        await page.evaluate(() => {
          window.__menuViewport._height = 400;
          window.__menuViewport.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(
          () => Math.abs(document.querySelector("#app").getBoundingClientRect().height - 400) < 1,
        );
        assert.equal(await page.locator("#prompt").inputValue(), draft);
        // No final resize event and no correction of visualViewport.height: blur and navigation must clear the stale pin.
        await page.locator("#prompt").evaluate((input) => input.blur());
        await aligned("keyboard dismissed with stale metrics");
      }
      await sidebar("tasks");
      await aligned("leave creation");
      await sidebar("create");
      await aligned("return creation");
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      if (mobile) await page.locator("#workspaceNavigationToggle").click();
      await page.locator("#newTask").click();
      await page.waitForURL((url) => url.pathname === "/new");
      await page.locator("#prompt").waitFor();
      assert.equal(await page.locator("#prompt").count(), 1);
      await sidebar("create");
      await aligned("new free session back to creation");
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await aligned("locale switch");
      await page.screenshot({ path: `${out}/create-${locale}-${width}.png` });
      await page.reload();
      await page.locator(".creation-skill-discovery").waitFor();
      await aligned("refresh matches menu layout");
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      assert.deepEqual(errors, []);
      results.push({ width, locale, mobile, measurements, draftRetained: true, errors });
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
