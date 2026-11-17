import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { materialOffice, textPdf } from "../support/material-text.js";
import { officeFixture } from "../support/office-presentation.js";

const out = ".artifacts/creation-materials-browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
    applicationCreation: true,
    models: [
      {
        id: "gpt-fixture",
        model: "gpt-fixture",
        isDefault: true,
        displayName: "Fixture model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  }),
  results = [];
try {
  for (const [engine, width, locale, name, bytes, expected] of [
    [chromium, 1600, "en", "requirements.pdf", textPdf({ chinese: true }), "需求文档"],
    [webkit, 430, "zh-CN", "requirements.docx", materialOffice("docx").bytes(), "Field\tRequired"],
    [webkit, 390, "zh-HK", "fields.xlsx", materialOffice("xlsx").bytes(), '"value":"字段"'],
    [webkit, 320, "zh-TW", "slides.pptx", officeFixture().bytes(), "Hello world\nNext line"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript(() => {
        if (window === top && /^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
      });
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/create");
      await page.locator("#composerSkillControl button").waitFor();
      await page.locator('.creation-discovery-card [data-skill-id="software-prd"]:enabled').click();
      const uploaded = page.waitForResponse(
        (r) => r.url().includes("/api/creation-materials?name=") && r.request().method() === "POST",
      );
      await page
        .locator("#attachmentInput")
        .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
      const response = await uploaded;
      assert.equal(response.status(), 201);
      const { attachment } = await response.json();
      const chip = page.locator("#composerAttachments .composer-attachment").filter({ hasText: name });
      await chip.waitFor({ state: "attached" });
      if (!(await chip.isVisible())) {
        await page.locator('[data-manage-composer-context="files"]').click();
        await chip.waitFor();
        await page.screenshot({ path: `${out}/files-${locale}-${width}.png` });
        await page.keyboard.press("Escape");
        assert(
          await page
            .locator('[data-manage-composer-context="files"]')
            .evaluate((node) => node === document.activeElement),
        );
      }
      await page.locator("#prompt").fill("Use the attached material to write the requirements. " + locale);
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert((await page.locator("#prompt").inputValue()).includes(locale));
      assert((await chip.isVisible()) || (await page.locator('[data-manage-composer-context="files"]').isVisible()));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${out}/attachment-${locale}-${width}.png` });
      const original = await context.request.get(app.base + attachment.url);
      assert.equal(original.status(), 200);
      assert.deepEqual(await original.body(), Buffer.from(bytes));
      const before = app.calls().length;
      const submitted = page.waitForResponse(
        (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const accepted = await submitted;
      assert.equal(accepted.status(), 202, await accepted.text());
      const task = (await accepted.json()).task;
      assert.equal(accepted.request().postDataJSON().locale, locale);
      const question = page.locator(".creation-session-status .user-input-card");
      await question.waitFor();
      await question.locator(".user-input-option").first().click();
      await question.locator(".user-input-submit").click();
      await waitFor(async () => {
        const response = await context.request.get(app.base + "/api/personal/document-creations/detail?id=" + task.id);
        return (await response.json()).task.state === "succeeded";
      });
      const reads = app
        .calls()
        .slice(before)
        .filter((call) => call.type === "response" && String(call.id).startsWith("material-"));
      assert.equal(reads.length, 1);
      assert.equal(reads[0].result.success, true);
      const content = JSON.parse(reads[0].result.contentItems.find((item) => typeof item.text === "string").text);
      assert(content.content.includes(expected));
      assert.equal(content.nextOffset, null);
      await page.locator("#prompt").fill("Continue polishing this saved document.");
      await page.reload();
      await page.locator("#prompt").waitFor();
      await page.waitForFunction(() => document.querySelector("#prompt").value.includes("Continue polishing"));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${out}/saved-${locale}-${width}.png` });
      assert.deepEqual(errors, []);
      results.push({
        locale,
        width,
        name,
        originalRetained: true,
        applicationTextRead: true,
        localeSwitchDraftRetained: true,
        savedReloadDraftRetained: true,
        errors,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.stop();
  await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
}
