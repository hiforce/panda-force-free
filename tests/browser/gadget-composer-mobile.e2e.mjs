import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-composer-mobile";
await mkdir(out, { recursive: true });
const app = await createAppFixture();
app.legacyProject({ name: "eshop-sample", code: "eshop-sample" });
const results = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 430, "en", "aurora"],
    [webkit, 390, "zh-CN", "aurora"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "silk"],
  ]) {
    const mobile = width < 768,
      browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: mobile,
        isMobile: mobile,
        locale,
      });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window === window.top && /^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/workspace");
      await page.locator("[data-gw=customize]:enabled").waitFor();
      assert.equal(await page.locator(".gadget-canvas > .gadget-instance").count(), 4);
      assert.equal(await page.locator('.gadget-canvas [data-gadget-type-id="system.attention"]').count(), 0);
      const prompt = page.locator("#gadgetDocumentPrompt");
      await prompt.fill("Create a launch plan with a clear timeline.");
      const inputHeight = (await prompt.boundingBox()).height;
      assert(inputHeight >= (mobile ? 180 : 160));
      if (mobile) assert.equal(await prompt.evaluate((n) => getComputedStyle(n).fontSize), "16px");
      // Safari toolbar taps can leave the textarea focused. Preserve that state until the actual open handler.
      await page.evaluate(() => {
        const field = document.querySelector("#gadgetDocumentPrompt");
        field.focus();
        field.setSelectionRange(7, 12);
        document.querySelector("[data-gd-skills]").click();
      });
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.waitFor();
      assert.equal(await page.locator(".creation-dialog[open]").count(), 0);
      if (mobile) {
        assert.equal(await picker.locator("[data-skill-search]").evaluate((n) => n === document.activeElement), false);
        assert.equal(await prompt.evaluate((n) => n === document.activeElement), false);
        assert(await picker.locator("header [data-skill-browser-close]").evaluate((n) => n === document.activeElement));
      } else assert(await picker.locator("[data-skill-search]").evaluate((n) => n === document.activeElement));
      const chosen = picker.locator("[data-skill-id=software-prd]");
      await chosen.waitFor();
      assert(await picker.locator("footer > a .icon-slot").isVisible());
      const searchBounds = await picker.locator("[data-skill-search]").boundingBox();
      const dialogWidth = (await picker.boundingBox()).width;
      assert(
        searchBounds.x >= 0 && searchBounds.x + searchBounds.width <= (mobile ? width : searchBounds.x + dialogWidth),
        "Search stays inside the picker",
      );
      assert(
        await picker.evaluate((n) => n.scrollWidth <= n.clientWidth),
        "Picker children cannot overflow the viewport",
      );
      await page.screenshot({ path: `${out}/picker-${locale}-${width}.png` });
      await chosen.click();
      await picker.locator("[data-skill-id=meeting-notes]").click();
      await picker.locator("footer [data-skill-browser-close]").click();
      const selected = page.locator("[data-gd-selected]");
      await selected.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      assert.equal(await selected.locator(".creative-skill-chip").count(), 2);
      const attachments = await selected.boundingBox(),
        input = await prompt.boundingBox();
      assert(attachments.y + attachments.height <= input.y + 1, "Selected skills stay above the brief");
      const art = await selected.locator(".creative-skill-art").first().boundingBox();
      assert(Math.abs(art.width - 56) < 1 && Math.abs(art.height - 40) < 1);
      const label = selected.locator(".creative-skill-label strong").first();
      assert(
        await label.evaluate((n) => n.clientWidth >= 90 && n.scrollHeight <= n.clientHeight + 1),
        "The full ordinary skill title fits",
      );
      assert.equal(await prompt.inputValue(), "Create a launch plan with a clear timeline.");
      assert.deepEqual(await prompt.evaluate((n) => [n.selectionStart, n.selectionEnd]), [7, 12]);
      assert(await page.locator("[data-gd-skills]").evaluate((n) => n === document.activeElement));
      await page.screenshot({ path: `${out}/composer-${locale}-${width}.png` });
      await page.locator("[data-gd-skills]").click();
      if (mobile) {
        // Headless WebKit has no OS keyboard. Exercise the same visualViewport events with a smaller visible area.
        await picker.locator("[data-skill-search]").focus();
        await page.evaluate(() => {
          const viewport = window.visualViewport;
          Object.defineProperty(viewport, "height", { configurable: true, value: 380 });
          Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 20 });
          viewport.dispatchEvent(new Event("resize"));
        });
        const dialogBounds = await picker.boundingBox(),
          doneBounds = await picker.locator("footer [data-skill-browser-close]").boundingBox();
        assert(dialogBounds.y >= 19 && dialogBounds.y + dialogBounds.height <= 401);
        assert(doneBounds.y >= 20 && doneBounds.y + doneBounds.height <= 400);
        assert(await picker.locator(".creation-skill-browser-scroll").evaluate((n) => n.clientHeight > 0));
        await page.screenshot({ path: `${out}/visible-viewport-${locale}-${width}.png` });
        await page.evaluate(() => {
          delete window.visualViewport.height;
          delete window.visualViewport.offsetTop;
          window.visualViewport.dispatchEvent(new Event("resize"));
        });
      }
      await page.keyboard.press("Escape");
      assert.equal(await picker.count(), 0);
      assert(await page.locator("[data-gd-skills]").evaluate((n) => n === document.activeElement));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      // The shared host still supports entering and cancelling layout customization without replacing the draft.
      await page.locator("[data-gw=customize]").click();
      await page.locator("[data-gw=cancel]").click();
      assert.equal(await prompt.inputValue(), "Create a launch plan with a clear timeline.");
      assert.deepEqual(errors, []);
      results.push({
        width,
        locale,
        inputHeight,
        blurAndFocus: true,
        attachmentsAboveBrief: true,
        viewportGeometry: mobile ? "simulated-keyboard" : "desktop",
        physicalKeyboardAcceptance: mobile ? "pending-real-iPhone" : "not-applicable",
        passed: true,
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
