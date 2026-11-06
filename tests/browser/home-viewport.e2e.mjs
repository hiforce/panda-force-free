import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

const fixture = await createBrowserFixture();
const engine = process.env.PANDA_FORCE_TEST_BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
});
const directory = `.artifacts/h5-home/${engine}`;
await mkdir(directory, { recursive: true });
try {
  for (const width of [320, 390, 430]) {
    const context = await browser.newContext({
      viewport: { width, height: 680 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      colorScheme: "dark",
    });
    await fixture.signIn(context);
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem("panda-force-locale", "zh-CN");
      const native = window.visualViewport,
        viewport = new EventTarget();
      for (const name of ["width", "height", "scale", "offsetTop", "offsetLeft"])
        Object.defineProperty(viewport, name, { get: () => viewport[`_${name}`] ?? native[name] });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.__keyboardViewport = viewport;
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.base + "/workspace");
    // A hidden preparation panel may not have mounted yet during a cold startup.
    await page.locator("#workbenchView").waitFor({ state: "visible" });
    await page.locator(".workbench-mobile-nav").waitFor({ state: "visible" });
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    const aligned = async () => {
      await page.waitForFunction(
        () => {
          const app = document.querySelector("#app")?.getBoundingClientRect();
          const nav = document.querySelector(".workbench-mobile-nav")?.getBoundingClientRect();
          return (
            app &&
            nav &&
            visualViewport.height === 680 &&
            Math.abs(app.height - visualViewport.height) < 1 &&
            Math.abs(nav.bottom - (visualViewport.offsetTop + visualViewport.height)) < 1
          );
        },
        null,
        { timeout: 3000 },
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    };
    await aligned();
    // Let startup sampling finish so it cannot mask a missing recovery listener.
    await page.waitForTimeout(700);
    // A restored page can have an old CSS height without receiving another viewport resize.
    await page.evaluate(() => {
      const v = window.__keyboardViewport;
      v._height = 340;
      v.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(() => document.querySelector("#app").getBoundingClientRect().height === 340);
    await page.evaluate(() => {
      const v = window.__keyboardViewport;
      v._height = 680;
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await aligned();
    await page.locator("#prompt").fill("保留首页草稿与光标");
    await page.locator("#prompt").evaluate((input) => {
      input.focus();
      input.setSelectionRange(2, 5);
    });
    await page.evaluate(() => {
      window.__keyboardViewport._height = 340;
      window.__keyboardViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(
      () => {
        const button = document.querySelector("#sendButton"),
          rect = button.getBoundingClientRect();
        return (
          rect.top >= visualViewport.offsetTop &&
          rect.bottom <= visualViewport.offsetTop + visualViewport.height &&
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("#sendButton") ===
            button
        );
      },
      null,
      { timeout: 3000 },
    );
    assert.deepEqual(
      await page
        .locator("#prompt")
        .evaluate((input) => [input.value, input.selectionStart, input.selectionEnd, input === document.activeElement]),
      ["保留首页草稿与光标", 2, 5, true],
    );
    if (width === 390) await page.screenshot({ path: directory + "/keyboard.png" });
    // Some keyboards finish their animation after blur, with no final resize notification.
    await page.evaluate(() => {
      document.querySelector("#prompt").blur();
      setTimeout(() => {
        window.__keyboardViewport._height = 680;
      }, 180);
    });
    await aligned();
    assert.equal(await page.locator("#prompt").inputValue(), "保留首页草稿与光标");
    await page.locator("#workbenchView").evaluate((view) => {
      view.scrollTop = 0;
    });
    if (width === 390) await page.screenshot({ path: directory + "/restored.png" });
    // Home has one scroll owner; later content remains reachable above the navigation.
    await page.locator("#workbenchView").evaluate((view) => {
      view.scrollTop = view.scrollHeight;
    });
    assert.ok(await page.locator("#workbenchView").evaluate((view) => view.scrollTop > 0));
    await page.locator('.workbench-mobile-nav [data-route="tasks"]').tap();
    await page.waitForURL("**/tasks");
    await aligned();
    await page.locator('.workbench-mobile-nav [data-route="workspace"]').tap();
    await page.waitForURL("**/workspace");
    await aligned();
    assert.equal(await page.locator("#prompt").inputValue(), "保留首页草稿与光标");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Home viewport: restored navigation, delayed keyboard dismissal, reachable composer, scroll and draft preservation passed at 320/390/430 px.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
