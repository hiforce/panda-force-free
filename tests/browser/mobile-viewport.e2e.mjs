import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
import { createAppFixture } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
let browser;
const results = [];
try {
  browser = await chromium.launch(launchOptions());
  for (const [device, width, height] of [
    ["iPhone 13", 320, 844],
    ["iPhone 13", 390, 844],
    ["Pixel 7", 430, 915],
    ["iPhone 13", 844, 390],
    [null, 1280, 800],
  ]) {
    const context = await browser.newContext({
      ...(device ? devices[device] : {}),
      viewport: { width, height },
      screen: { width, height },
    });
    context.setDefaultTimeout(10_000);
    await fixture.signIn(context);
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem("panda-force-locale", "en");
      const native = window.visualViewport,
        viewport = new EventTarget();
      for (const name of ["width", "height", "scale", "offsetTop", "offsetLeft"])
        Object.defineProperty(viewport, name, { get: () => viewport[`_${name}`] ?? native[name] });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.__keyboardViewport = viewport;
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.__pandaForceTest = true;
    });
    await page.goto(fixture.base + "/new", { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => {
      document.querySelector("#threadTitle").textContent = "这是很长的项目会话标题，用于检查手机屏幕上的顶部布局";
      document.querySelector("#threadPath").textContent = "/home/coding/projects/a-very-long-project-folder";
      document.querySelector("#composerProjectLabel").textContent = "a-very-long-project-folder";
      document.querySelector("#modelLabel").textContent = "GPT-6.1 Codex with a very long model name";
      document.querySelector("#effortLabel").textContent = "Extra high";
    });
    const measure = () =>
      page.evaluate(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          innerWidth,
          innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scale: visualViewport.scale,
          viewportTop: visualViewport.offsetTop,
          viewportHeight: visualViewport.height,
          app: box(".app-shell"),
          header: box(".topbar"),
          heading: box(".thread-heading"),
          title: box("#threadTitle"),
          actions: box(".top-actions"),
          send: box("#sendButton"),
          model: box("#modelButton"),
          footer: box(".composer-footer"),
          fonts: [
            "#prompt",
            "#passwordInput",
            "#passwordConfirmInput",
            "#threadSearch",
            "#folderPathInput",
            "#browserUrl",
            "#settingsSearch",
            "#languageSelect",
          ].map((selector) => ({
            selector,
            size: parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
          })),
          active: document.documentElement.classList.contains("visual-viewport-active"),
        };
      });
    const before = await measure();
    assert.ok(before.scrollWidth <= width, JSON.stringify(before));
    assert.ok(before.send.right <= width && before.send.left >= 0);
    if (device) {
      assert.ok(before.model.right <= before.footer.right + 1, JSON.stringify(before));
      assert.ok(before.actions.right <= width && before.heading.width > 30 && before.title.width > 0);
      assert.ok(
        before.fonts.every((font) => font.size >= 16),
        JSON.stringify(before.fonts),
      );
      const meta = await page.locator("meta[name=viewport]").getAttribute("content");
      assert.ok(meta.includes("interactive-widget=resizes-content"));
      assert.ok(!/user-scalable=no|maximum-scale=1/.test(meta));
      await page.locator("#prompt").focus();
      // Reproduce browsers whose keyboard changes only the visual viewport.
      const keyboardHeight = Math.min(400, height - 100),
        keyboardTop = 60;
      await page.evaluate(
        ({ keyboardHeight, keyboardTop }) => {
          const viewport = window.__keyboardViewport;
          viewport._height = keyboardHeight;
          viewport._offsetTop = keyboardTop;
          viewport.dispatchEvent(new Event("resize"));
          viewport.dispatchEvent(new Event("scroll"));
        },
        { keyboardHeight, keyboardTop },
      );
      await page.waitForFunction(
        ({ keyboardHeight, keyboardTop }) => {
          const rect = document.querySelector(".app-shell").getBoundingClientRect();
          return Math.abs(rect.height - keyboardHeight) < 1 && Math.abs(rect.top - keyboardTop) < 1;
        },
        { keyboardHeight, keyboardTop },
      );
      const keyboard = await measure();
      assert.ok(keyboard.header.top >= keyboardTop && keyboard.header.bottom <= keyboardTop + keyboardHeight);
      assert.ok(
        keyboard.send.top >= keyboardTop &&
          keyboard.send.bottom <= keyboardTop + keyboardHeight &&
          keyboard.send.right <= width,
        JSON.stringify({ device, width, height, keyboardHeight, keyboardTop, keyboard }),
      );
      assert.equal(keyboard.scale, 1);
      assert.equal(
        await page.locator("#sendButton").evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return (
            document
              .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
              ?.closest("#sendButton") === button
          );
        }),
        true,
        "The mobile navigation must not intercept the send button",
      );
      if (width === 390) await page.screenshot({ path: artifact("mobile-keyboard-layout.png") });
      for (const [trigger, menu] of [
        ["#modelButton", "#modelMenu"],
        ["#modeButton", "#permissionMenu"],
      ]) {
        await page.locator(trigger).click();
        await page.locator(menu).waitFor({ state: "visible" });
        const bounds = await page.locator(menu).boundingBox();
        assert.ok(bounds.width > 0 && bounds.height > 0);
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
        assert.ok(
          bounds.y >= keyboardTop && bounds.y + bounds.height <= keyboardTop + keyboardHeight,
          JSON.stringify({ keyboardTop, keyboardHeight, bounds }),
        );
        await page.locator(menu + " .session-menu-close").click();
        await page.locator(menu).waitFor({ state: "hidden" });
        assert.equal(await page.locator(trigger).evaluate((button) => button === document.activeElement), true);
      }
      // Manual zoom remains native; the app must not override the user's scale.
      await page.evaluate(() => {
        const v = window.__keyboardViewport;
        v._scale = 2;
        v.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() => !document.documentElement.classList.contains("visual-viewport-active"));
      assert.equal((await measure()).scale, 2);
      await page.evaluate(() => {
        const v = window.__keyboardViewport;
        v._scale = 1;
        delete v._height;
        delete v._offsetTop;
        v.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(
        () => Math.abs(document.querySelector(".app-shell").getBoundingClientRect().height - innerHeight) < 1,
      );
      if (width === 390) await page.screenshot({ path: artifact("mobile-viewport-after.png") });
      results.push({ device, width, keyboardHeight, inputFont: before.fonts[0].size, modelFits: true, sendFits: true });
    } else {
      assert.equal(before.active, false);
      assert.equal(before.fonts[0].size, 15);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ mobileViewport: results, desktopUnchanged: true, pinchZoomPreserved: true }));
} finally {
  await browser?.close();
  await fixture.dispose();
}
