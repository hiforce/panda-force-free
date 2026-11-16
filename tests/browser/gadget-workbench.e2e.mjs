import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-workbench";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ applicationCreation: true });
const results = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [webkit, 320, "zh-TW", "silk"],
    [chromium, 1440, "zh-HK", "aurora"],
    [webkit, 390, "zh-CN", "dark"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window === window.top) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/workspace");
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/debug-${locale}-${width}.png` });
      await writeFile(
        `${out}/debug-${locale}.json`,
        JSON.stringify(
          {
            url: page.url(),
            errors,
            body: await page.locator("body").innerText(),
            catalogStatus: (await context.request.get(app.base + "/api/gadgets/catalog")).status(),
          },
          null,
          2,
        ),
      );
      await page.locator("[data-gw=customize]:enabled").waitFor();
      assert.equal(await page.locator("html").getAttribute("data-appearance"), theme === "dark" ? "graphite" : theme);
      const actions = page.locator(".gadget-workspace-actions");
      const titleBounds = await page.locator(".gadget-workspace-heading h1").boundingBox();
      const actionBounds = await actions.boundingBox();
      assert(titleBounds.x + titleBounds.width <= actionBounds.x, "Heading and actions must not overlap");
      for (const action of ["activity", "customize"]) {
        const control = actions.locator(`[data-gw="${action}"]`),
          label = await control.getAttribute("aria-label"),
          bounds = await control.boundingBox();
        assert(label?.trim());
        assert.equal(await control.getAttribute("title"), label);
        const labelVisible = await control.locator("span:not(.icon-slot)").isVisible();
        assert.equal(labelVisible, width >= 768);
        if (width < 768) {
          assert(bounds.width >= 44 && bounds.height >= 44);
          assert(Math.abs(bounds.width - bounds.height) < 1, "Mobile actions must remain square");
        }
      }
      await page.screenshot({ path: `${out}/heading-${locale}-${width}-${theme}.png` });
      await page.locator('.gadget-instance[data-gadget-type-id="system.recent"] .gadget-row').first().waitFor();
      assert.equal(await page.locator("#workbenchView h1:visible").count(), 1);
      assert.equal(await page.locator(".gadget-instance .gadget-error").count(), 0);
      assert.equal(await page.locator("#workbenchGlobalTitle").count(), 0);
      assert.equal(await page.locator(".gadget-workspace-heading > div > small").count(), 0);
      const firstContentOffset = await page.evaluate(() => {
        const topbar = document.querySelector(".topbar").getBoundingClientRect();
        const canvas = document.querySelector(".gadget-canvas").getBoundingClientRect();
        return canvas.top - topbar.bottom;
      });
      assert.ok(firstContentOffset <= (width < 360 ? 112 : 88), "The first gadget stays near the application bar");
      const customize = await page.locator("[data-gw=customize]").boundingBox();
      assert.ok(customize.width >= (width < 768 ? 44 : 40) && customize.height >= (width < 768 ? 44 : 40));
      await page.locator("#gadgetDocumentPrompt").fill("Preserve this draft across all layout changes.");
      const node = await page.locator("#gadgetDocumentPrompt").evaluateHandle((n) => n);
      await page.screenshot({ path: `${out}/home-${locale}-${width}.png` });
      await page.locator("[data-gw=customize]").click();
      await page.locator('.gadget-instance[data-gadget-type-id="system.recent"] [data-gw=config]').click();
      const panel = width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await panel.locator("#gadgetTitle").fill("My recent work");
      await panel.locator("#gadgetTitle").blur();
      if (width < 1050) await panel.locator("[data-ge=close]").click();
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Preserve this draft across all layout changes.",
      );
      assert(await node.evaluate((n) => n === document.querySelector("#gadgetDocumentPrompt")));
      await page.screenshot({ path: `${out}/editing-${locale}-${width}.png` });
      await page.locator("[data-gw=save]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.reload();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      assert.equal(await page.locator('[data-gadget-type-id="system.recent"] h2').innerText(), "My recent work");
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Preserve this draft across all layout changes.",
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({ locale, width, errors, passed: true });
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
