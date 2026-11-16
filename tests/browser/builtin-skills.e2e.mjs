import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

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
});
const out = ".artifacts/builtin-skills/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (window === window.top && /^https?:$/.test(location.protocol))
          localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const api = async (path) => {
        const response = await context.request.get(app.base + path);
        assert.ok(response.ok(), await response.text());
        return response.json();
      };
      const pack = (await api("/api/skill-packs/detail?id=panda-force.essentials&version=1.0.0")).package;
      assert.equal(pack.manifest.skills.length, 18);
      assert.equal(pack.exports.filter((e) => e.enabled).length, 18);
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => errors.push(e.message));
      for (const category of ["writing", "research", "slides", "image", "web", "video"]) {
        await page.goto(app.base + "/skills/" + category);
        const native = page.locator('[data-template-key*="panda-force.essentials"]');
        await native.first().waitFor();
        assert.equal(await native.count(), pack.manifest.skills.filter((s) => s.category === category).length);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const art = await native.evaluateAll((cards) => cards.map((c) => c.querySelector(".skill-artwork")?.innerHTML));
        assert.ok(art.every(Boolean));
        assert.equal(new Set(art).size, art.length);
        await page.screenshot({ path: out + "/" + category + "-" + width + ".png" });
      }
      await page.goto(app.base + "/skills/writing");
      await page
        .locator('[data-template-key*="panda-force.essentials"]')
        .filter({ hasText: locale === "en" ? "Software PRD" : "软件需求 PRD" })
        .click();
      const dialog = page.locator("#managedTemplateDialog[open]");
      await dialog.locator('[data-template-detail="apply"]:visible').waitFor();
      assert.match(
        await dialog.innerText(),
        locale === "en" ? /Deliverable: an editable document/ : /交付物：可编辑文档/,
      );
      await dialog.locator('[data-template-detail="preview"]').click();
      await dialog
        .frameLocator("[data-template-preview] iframe")
        .locator("body")
        .filter({ hasText: "stable requirement IDs" })
        .waitFor();
      await page.screenshot({ path: out + "/detail-" + width + ".png" });
      await dialog.locator('[data-template-detail="apply"]').click();
      await page.locator("#gadgetDocumentPrompt").fill("Draft a PRD for a document review flow.");
      assert.match(await page.locator("[data-gd-selected]").innerText(), /software-prd/);
      await page.locator("[data-gd-start]").click();
      await page.locator(".creation-task .user-input-option").first().click();
      await page.locator(".creation-task .user-input-submit").first().click();
      await page.locator('.creation-task [data-creation-action="open"]').first().waitFor();
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        theme,
        seeded: 18,
        categories: 6,
        authoredCovers: true,
        scopedDocumentCreation: "fixture-verified",
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(".artifacts/builtin-skills/verification.json", JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  await app.dispose();
}
