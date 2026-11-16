import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-interactions";
await mkdir(out, { recursive: true });
const app = await createAppFixture();
const results = [];
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      let failLoad = true;
      const loadRoute = async (route) => {
        if (failLoad) await route.abort();
        else await route.continue();
      };
      await page.route("**/api/gadgets/layout", loadRoute);
      await page.goto(app.base + "/workspace");
      await page.locator("#gadgetDocumentPrompt").fill("Keep the task draft through every layout operation");
      const prompt = await page.locator("#gadgetDocumentPrompt").evaluateHandle((node) => node);
      await page.locator("[data-gw=retry-load]").waitFor();
      assert(await page.locator("[data-gw=customize]").isDisabled());
      failLoad = false;
      await page.locator("[data-gw=retry-load]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.unroute("**/api/gadgets/layout", loadRoute);
      const before = await (await context.request.get(app.base + "/api/gadgets/layout")).json();
      await page.locator("[data-gw=customize]").click();
      const recent = page.locator('[data-gadget-type-id="system.recent"]'),
        id = await recent.getAttribute("data-gadget-instance");
      if (width >= 768) {
        const handle = recent.locator("[data-gadget-handle]");
        await handle.focus();
        const old = await recent.evaluate((el) => Number(el.style.getPropertyValue("--gadget-y")));
        await handle.press("ArrowDown");
        assert.equal(await recent.evaluate((el) => Number(el.style.getPropertyValue("--gadget-y"))), old + 1);
        await handle.press("Shift+ArrowDown");
        const size = await recent.evaluate((el) => Number(el.style.getPropertyValue("--gadget-h")));
        await recent.locator("[data-gadget-resize]").scrollIntoViewIfNeeded();
        const box = await recent.locator("[data-gadget-resize]").boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 36, { steps: 5 });
        await page.mouse.up();
        assert.equal(await recent.evaluate((el) => Number(el.style.getPropertyValue("--gadget-h"))), size + 1);
        await page.locator("[data-gw=undo]").click();
        assert.equal(await recent.evaluate((el) => Number(el.style.getPropertyValue("--gadget-h"))), size);
        await page.locator("[data-gw=preview]:visible").click();
        assert.equal(await page.locator(".gadget-resize").count(), 0);
        await page.locator("[data-gw=preview]:visible").click();
      } else {
        while (await recent.locator("[data-gw=up]").isEnabled()) await recent.locator("[data-gw=up]").click();
        assert.equal(await page.locator(".gadget-instance").first().getAttribute("data-gadget-instance"), id);
        const target = await recent.locator("[data-gw=config]").boundingBox();
        assert(target.width >= 44 && target.height >= 44);
      }
      assert(await prompt.evaluate((node) => node === document.querySelector("#gadgetDocumentPrompt")));
      let lost = true;
      const operations = [];
      const saveRoute = async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        operations.push(route.request().postDataJSON().operationId);
        if (lost) {
          lost = false;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          await route.abort();
        } else await route.continue();
      };
      await page.route("**/api/gadgets/layout", saveRoute);
      await page.locator("[data-gw=save]").click();
      await page.locator("[data-gw=save]:enabled").waitFor();
      assert(await page.locator("[data-gw=cancel]").isDisabled());
      await page.locator("[data-gw=save]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.unroute("**/api/gadgets/layout", saveRoute);
      assert.equal(operations.length, 2);
      assert.equal(operations[0], operations[1]);
      const saved = await (await context.request.get(app.base + "/api/gadgets/layout")).json();
      assert.equal(saved.revision, before.revision + 1);
      if (width < 768) {
        assert.deepEqual(saved.items, before.items);
        assert.equal(saved.mobileOrder[0], id);
      }
      await page.locator("[data-gw=customize]").click();
      await recent.locator("[data-gw=config]").click();
      const panel = width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await panel.locator("#gadgetTitle").fill("My layout draft");
      await panel.locator("#gadgetTitle").blur();
      if (width < 1050) await panel.locator("[data-ge=close]").click();
      const remote = await context.request.put(app.base + "/api/gadgets/layout", {
        data: {
          operationId: crypto.randomUUID(),
          layout: { ...saved, density: saved.density === "compact" ? "comfortable" : "compact" },
        },
        headers: { Origin: app.base, "If-Match": `"${saved.revision}"` },
      });
      assert.equal(remote.status(), 200);
      await page.locator("[data-gw=save]").click();
      await page.locator("[data-gw=reload-saved]").waitFor();
      assert.equal(await recent.locator("h2").innerText(), "My layout draft");
      await page.locator("[data-gw=reload-saved]").click();
      await page.locator(".gadget-confirm [data-confirm-yes]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.locator("[data-gw=customize]").click();
      const composer = page.locator('[data-gadget-type-id="system.composer"]');
      await composer.locator("[data-gw=remove]").click();
      await page.locator("[data-gw=library]:visible").first().click();
      const library = width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await library.locator('[data-ge=add][data-type="system.composer"]').click();
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Keep the task draft through every layout operation",
      );
      // Removing the document composer disposes its DOM; its scoped draft survives a fresh mount.
      assert(await prompt.evaluate((node) => !node.isConnected));
      if (width < 1050 && (await page.locator(".gadget-editor-dialog[open]").count()))
        await page.locator(".gadget-editor-dialog [data-ge=close]").click();
      await page.locator("[data-gw=cancel]").click();
      await page.locator(".gadget-confirm [data-confirm-yes]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-HK"));
      await page.locator('[data-gw=customize][aria-label="自訂工作台"]').waitFor();
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Keep the task draft through every layout operation",
      );
      await page.screenshot({ path: `${out}/recovered-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({
        width,
        slowLoad: true,
        uncertainSave: true,
        conflict: true,
        nativeDraft: true,
        mobileOrder: width < 768,
        errors,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
