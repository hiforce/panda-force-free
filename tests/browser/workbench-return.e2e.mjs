import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/workbench-return";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ applicationCreation: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 768,
        isMobile: width < 768,
        locale,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (window !== top || !/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "dark");
        const native = visualViewport,
          viewport = new EventTarget();
        for (const key of ["height", "width", "offsetTop", "offsetLeft", "scale"])
          Object.defineProperty(viewport, key, { get: () => viewport["_" + key] ?? native[key] });
        Object.defineProperty(window, "visualViewport", { value: viewport });
        window.__returnViewport = viewport;
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(url, ...args) {
            if (String(url).endsWith("/ws")) throw new Error("Exercise the HTTP recovery transport");
            super(url, ...args);
          }
        };
        window.__returnFocus = [];
        document.addEventListener("focusin", (event) => {
          if (window.__watchReturnFocus && event.target?.id === "prompt") window.__returnFocus.push("prompt");
        });
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      // A valid direct-link session need not be present in the first sidebar page.
      await page.route("**/api/rpc", async (route) => {
        if (route.request().postDataJSON()?.method !== "thread/list") return route.continue();
        const response = await route.fetch(),
          body = await response.json();
        body.result.data = body.result.data.filter((thread) => thread.id !== "old-beta");
        await route.fulfill({ response, json: body });
      });
      const workspace = async () => {
        const link = page.locator('.workbench-navigation [data-route="workspace"]');
        if ((await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded")) !== "true")
          await page.locator("#workspaceNavigationToggle").click();
        await link.click();
        await page.waitForURL("**/workspace");
        await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      };
      await page.goto(app.base + "/workspace");
      await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      await page.locator("#gadgetDocumentPrompt").fill("Keep the workbench draft");
      const marker = app.calls().length;
      for (let repeat = 0; repeat < 2; repeat++) {
        await page.evaluate(() => globalThis.__pandaForceDebug.workbench.navigate("/task/old-alpha"));
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
        await page.locator("#prompt").fill("Keep the native draft");
        if (width < 768) {
          await page.evaluate(() => {
            const viewport = window.__returnViewport;
            viewport._height = 380;
            viewport._offsetTop = 20;
            viewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForFunction(
            () => document.documentElement.style.getPropertyValue("--app-viewport-height") === "380px",
          );
        }
        await page.evaluate(() => {
          window.__returnFocus = [];
          window.__watchReturnFocus = true;
        });
        await workspace();
        assert.deepEqual(
          await page.evaluate(() => window.__returnFocus),
          [],
          "Home navigation never focuses the hidden session input",
        );
        await page.waitForFunction(() => !document.body.classList.contains("session-layout"));
        assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "Keep the workbench draft");
        assert(!(await page.locator("#composer").isVisible()));
        if (width < 768) {
          // Model WebKit retaining a hidden field while its keyboard metrics are stale.
          await page.evaluate(() => {
            const original = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement");
            window.__restoreActiveElement = () => delete document.activeElement;
            Object.defineProperty(document, "activeElement", {
              configurable: true,
              get: () => document.querySelector("#prompt") || original.get.call(document),
            });
            window.__returnViewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForFunction(() => !document.documentElement.style.getPropertyValue("--app-viewport-height"));
          await page.evaluate(() => window.__restoreActiveElement());
          assert(await page.locator(".workbench-mobile-nav").isVisible());
        }
        const geometry = await page.locator('[data-gadget-type-id="system.composer"]').evaluate((widget) => {
          const body = widget.querySelector(".gadget-body").getBoundingClientRect(),
            footer = widget.querySelector(".message-composer-footer").getBoundingClientRect(),
            app = document.querySelector(".app-shell").getBoundingClientRect();
          return {
            body: body.toJSON(),
            footer: footer.toJSON(),
            app: app.toJSON(),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert(!geometry.overflow);
        assert(
          geometry.footer.height >= 44 && geometry.footer.bottom <= geometry.body.bottom + 1,
          JSON.stringify(geometry),
        );
        assert(geometry.footer.y >= geometry.body.y, JSON.stringify(geometry));
        if (width < 768) assert(Math.abs(geometry.app.height - 900) <= 1, JSON.stringify(geometry));
        await page.screenshot({ path: `${out}/return-${locale}-${width}-${repeat}.png` });
        await page.evaluate(() => {
          window.__watchReturnFocus = false;
          delete window.__returnViewport._height;
          delete window.__returnViewport._offsetTop;
          window.__returnViewport.dispatchEvent(new Event("resize"));
        });
        await page.goBack();
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
        assert.equal(await page.locator("#prompt").inputValue(), "Keep the native draft");
        await page.goForward();
        await page.waitForURL("**/workspace");
        await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      }
      let release, started;
      const waiting = new Promise((resolve) => {
          started = resolve;
        }),
        gate = new Promise((resolve) => {
          release = resolve;
        });
      await page.route("**/api/rpc", async (route) => {
        const body = route.request().postDataJSON();
        if (["host/thread/history", "thread/read"].includes(body?.method) && body.params?.threadId === "old-beta") {
          started();
          await gate;
        }
        await route.fallback();
      });
      await page.evaluate(() => globalThis.__pandaForceDebug.workbench.navigate("/task/old-beta"));
      let deadline;
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Session history request did not start")), 15000);
      });
      await Promise.race([waiting, timeout]).finally(() => clearTimeout(deadline));
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.active), null);
      await workspace();
      release();
      await page.waitForTimeout(700);
      assert.equal(new URL(page.url()).pathname, "/workspace", "Late session reads cannot reclaim the route");
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.active), null);
      assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "Keep the workbench draft");
      await page.evaluate(() => globalThis.__pandaForceDebug.workbench.navigate("/create"));
      await page.locator(".creation-entry-composer #prompt").waitFor();
      await page.locator("#prompt").fill("Keep the creation history scope");
      await workspace();
      const workbenchDraft = await page.locator("#gadgetDocumentPrompt").inputValue();
      await page.goBack();
      await page.waitForURL("**/create");
      await page.locator(".creation-entry-composer #prompt").waitFor();
      await page.waitForFunction(() => document.querySelector("#prompt").value === "Keep the creation history scope");
      await page.goForward();
      await page.waitForURL("**/workspace");
      await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), workbenchDraft);
      assert(
        !app
          .calls()
          .slice(marker)
          .some((call) => ["thread/start", "turn/start"].includes(call.method)),
      );
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        menuReturn: true,
        backForward: true,
        draftsPreserved: true,
        noHiddenFocus: true,
        lateReadIgnored: true,
        creationHistoryPreserved: true,
        keyboard: width < 768 ? "simulated-stale-visual-viewport-and-hidden-focus" : "desktop",
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, contexts: records.length }));
} finally {
  await app.dispose();
}
