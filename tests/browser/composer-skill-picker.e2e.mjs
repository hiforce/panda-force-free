import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { randomUUID } from "node:crypto";

const out = ".artifacts/composer-skill-picker";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ applicationCreation: true });
const records = [];
const availabilityPackage = "availability.review-kit";
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
      if (!records.length) {
        for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
          const pack = await nativeSkillPackage(availabilityPackage, version),
            selected = version === "1.0.2" ? ["blog-outline"] : ["blog-outline", "brand-voice"],
            body = { content: pack.content, name: "availability.skill.json", selected },
            reviewResponse = await context.request.post(app.base + "/api/skill-packs/review", {
              data: body,
              headers: { Origin: app.base },
            });
          assert(reviewResponse.ok(), await reviewResponse.text());
          const review = await reviewResponse.json(),
            installation = await context.request.post(app.base + "/api/skill-packs/install", {
              headers: { Origin: app.base },
              data: {
                content: pack.content,
                name: "availability.skill.json",
                approval: {
                  id: randomUUID(),
                  expectedRevision: review.revision,
                  reviewHash: review.reviewHash,
                  capabilities: review.capabilities,
                  selected: review.selected,
                },
              },
            });
          assert(installation.ok(), await installation.text());
        }
      }
      const available = await (await context.request.get(app.base + "/api/skills?limit=100")).json(),
        useEntries = available.skills.filter((skill) => skill.packageId === availabilityPackage),
        history = await (
          await context.request.get(
            app.base +
              "/api/template-catalog?" +
              new URLSearchParams({ registry: "skills", view: "versions", search: availabilityPackage, limit: "100" }),
          )
        ).json();
      assert.deepEqual(
        useEntries.map((skill) => [skill.id, skill.version]),
        [["blog-outline", "1.0.2"]],
      );
      assert.equal(history.templates.filter((item) => item.reference.packageId === availabilityPackage).length, 9);
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
      await picker.locator("[data-skill-search]").fill(availabilityPackage);
      const candidates = picker.locator(".creation-skill-option");
      assert.equal(await candidates.count(), 1);
      assert.equal(await candidates.locator("[data-skill-action=add]").getAttribute("data-skill-id"), "blog-outline");
      assert.match(await candidates.locator("footer").innerText(), /v1\.0\.2/);
      assert.equal(await picker.locator(".creation-skill-availability").count(), 0);
      await picker.locator('[data-skill-category="research"]').click();
      assert.equal(await candidates.count(), 0);
      await picker.locator('[data-skill-category="all"]').click();
      assert.equal(await candidates.count(), 1);
      await page.screenshot({ path: `${out}/available-only-${locale}-${width}.png` });
      await picker.locator('[data-skill-category="writing"]').click();
      await picker.locator("[data-skill-search]").fill("");
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
      await page.goto(app.base + "/skills/writing");
      await page.locator(`[data-template-key*="${availabilityPackage}:blog-outline:"]`).click();
      const managed = page.locator(".template-detail-dialog[open]");
      await managed.locator('[data-template-detail="apply"]:visible').waitFor();
      await managed.locator('[data-template-detail="versions"]').click();
      const versions = managed.locator("[data-template-version]");
      await versions.first().waitFor();
      assert.equal(await versions.count(), 3);
      await versions.filter({ hasText: "1.0.0" }).click();
      await managed.locator('[data-template-detail="activate"]:visible').waitFor();
      assert.equal(await managed.locator('[data-template-detail="apply"]').isVisible(), false);
      await page.screenshot({ path: `${out}/history-only-${locale}-${width}.png` });
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
        availableCandidatesOnly: true,
        managementAndHistoryPreserved: true,
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
