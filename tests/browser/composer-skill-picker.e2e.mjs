import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/composer-skill-picker";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ applicationCreation: true });
const records = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "silk"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await app.signIn(context);
      const database = await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      assert(database.ok());
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
      let optionsReads = 0,
        submissions = 0,
        release = () => {},
        fail = false;
      page.on("request", (request) => {
        if (request.url().includes("/document-creations/options")) optionsReads++;
        if (request.method() === "POST" && /\/document-creations$/.test(new URL(request.url()).pathname)) submissions++;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/skill-packs?*", async (route) => {
        await gate;
        if (fail) return route.fulfill({ status: 503, json: { messageId: "plugins.packageUnavailable" } });
        await route.continue();
      });
      await page.goto(app.base + "/create");
      await page.locator("[data-gd-skills]:enabled").waitFor();
      const prompt = "Write a clear product requirements brief.";
      await page.locator("#gadgetDocumentPrompt").fill(prompt);
      await page.screenshot({ path: `${out}/before-${locale}-${width}.png` });
      await page.locator("[data-gd-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.waitFor();
      assert.equal(await page.locator(".creation-dialog[open]").count(), 0);
      assert.equal(optionsReads, 0);
      assert.equal(submissions, 0);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[data-gd-skills]").evaluate((node) => node === document.activeElement), true);
      await page.locator("[data-gd-skills]").click();
      if (locale === "zh-CN") fail = true;
      release();
      if (fail) {
        await picker.locator("[data-skill-browser-error]:visible").waitFor();
        fail = false;
        await picker.locator('[data-skill-action="more"]').click();
      }
      const prd = picker.locator('[data-skill-id="software-prd"]');
      await prd.waitFor();
      assert.equal(await picker.locator('[data-skill-category="all"]').getAttribute("aria-pressed"), "false");
      assert.equal(
        await picker.locator("[data-skill-categories] nav > button").first().getAttribute("data-skill-category"),
        "all",
      );
      await prd.click();
      await picker.locator('[data-skill-id="meeting-notes"]').click();
      await page.screenshot({ path: `${out}/picker-${locale}-${width}.png` });
      await picker.locator(".creation-skill-browser-footer [data-skill-browser-close]").click();
      const selected = page.locator("[data-gd-selected]");
      await selected.locator('.creative-skill-chip[data-selected-skill="software-prd"] .template-cover').waitFor();
      assert.equal(await selected.locator(".creative-skill-chip").count(), 2);
      assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), prompt);
      assert.equal(await page.locator(".creation-dialog[open]").count(), 0);
      assert.equal(optionsReads, 0);
      const preview = selected.locator('[data-selected-skill="software-prd"] .creative-skill-preview');
      const label = await preview.locator("strong").innerText();
      assert.match(
        label,
        locale === "en"
          ? /Software PRD/
          : locale === "zh-CN"
            ? /软件需求/
            : locale === "zh-HK"
              ? /軟件需求/
              : /軟體需求/,
      );
      assert.match(await preview.locator("small").innerText(), /v1\.0\.0/);
      const artwork = await preview.locator(".template-cover svg").boundingBox();
      assert.ok(artwork.width >= 50 && artwork.height >= 35);
      await page.screenshot({ path: `${out}/selected-${locale}-${width}.png` });
      if (locale === "zh-CN") {
        await page.locator("[data-gd-skills]").click();
        await picker.locator('[data-skill-category="all"]').click();
        await writeFile(
          `${out}/prototype-data.json`,
          JSON.stringify(
            {
              composer: await page.locator("[data-system-composer]").evaluate((node) => node.outerHTML),
              picker: await page.locator(".creation-skill-browser").evaluate((node) => node.outerHTML),
              options: await page.locator(".creation-skill-option").evaluateAll((nodes) =>
                nodes.map((node) => ({
                  id: node.querySelector("[data-skill-id]").dataset.skillId,
                  name: node.querySelector(".creation-skill-option-title").textContent,
                  cover: node.querySelector(".template-cover").outerHTML,
                  version: node.querySelector("small").textContent,
                })),
              ),
            },
            null,
            2,
          ),
        );
      }
      if (locale === "zh-CN") await page.keyboard.press("Escape");
      await preview.click();
      await page.locator(".creation-skill-detail[open]").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await preview.evaluate((node) => node === document.activeElement), true);
      await selected.locator('[data-selected-skill="meeting-notes"] [data-creative-remove-skill]').click();
      assert.equal(await selected.locator(".creative-skill-chip").count(), 1);
      await page.locator("[data-gd-skills]").click();
      assert.equal(await picker.locator('[data-skill-id="software-prd"]').getAttribute("aria-pressed"), "true");
      await picker.locator("[data-skill-search]").fill("PRD");
      await page.keyboard.press("Escape");
      await page.locator("[data-gd-skills]").click();
      assert.equal(await picker.locator("[data-skill-search]").inputValue(), "PRD");
      await page.keyboard.press("Escape");
      await page.reload();
      await page.locator('[data-selected-skill="software-prd"] .creative-skill-preview:enabled').waitFor();
      assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), prompt);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(optionsReads, 0);
      assert.equal(await page.locator("[data-gc-mode],[data-gc-more],[data-gc-menu]").count(), 0);
      assert.equal(submissions, 0);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        directPicker: true,
        noCreationOrOptionsOnSelection: true,
        coversAndVersions: true,
        inputAndSelectionPreserved: true,
        keyboardAndRetry: true,
        noOverflow: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.stop();
}
