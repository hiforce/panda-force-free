import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";

const fixture = await createAppFixture();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(context);
      const page = await context.newPage(),
        errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (!request.url().startsWith(fixture.base)) external.push(request.url());
      });
      await page.goto(fixture.base + "/publish/website");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const center = page.locator(".template-manager");
      await center.locator(".template-card").first().waitFor();
      assert.equal(await center.locator("h1").textContent(), locale === "en" ? "Site themes" : "站点主题");
      assert.equal(await center.locator(".template-card").count(), 2);
      await center.locator('[data-template-key^="builtin:site-theme:panda.journal:"]').click();
      const preview = page.locator("#managedTemplateDialog");
      const previewFrame = async (stage) => {
        console.log(`${engine.name()} ${width}: waiting for ${stage}`);
        try {
          await preview.locator("iframe").waitFor();
        } catch (error) {
          await mkdir(".artifacts/publishing-styles", { recursive: true });
          await page.screenshot({ path: `.artifacts/publishing-styles/failure-${width}-${stage}.png` });
          console.log(await preview.textContent());
          throw error;
        }
      };
      await preview.locator('[data-template-detail="preview"]:enabled').click();
      await preview.locator(".template-static-sample > summary").click();
      await previewFrame("site-sample");
      assert.equal(await preview.locator("iframe").getAttribute("sandbox"), "");
      assert.match(await preview.locator("iframe").getAttribute("srcdoc"), /Georgia,serif/);
      const siteDownloadPending = page.waitForEvent("download");
      await preview.locator('[data-template-detail="export"]').click();
      const siteDownload = await siteDownloadPending;
      const siteCopy = JSON.parse(await readFile(await siteDownload.path(), "utf8"));
      await verifyPluginPackage(siteCopy);
      assert.deepEqual(siteCopy.manifest.permissions, ["content:site-themes"]);
      assert.equal(siteCopy.manifest.siteThemes[0].kind, "profile");
      assert.equal(await preview.locator('[data-template-detail="edit"]').isVisible(), false);
      await preview.locator('[data-template-detail="close"]').click();
      const library = page.locator("#managedPublishingDrafts");
      await page.goto(fixture.base + "/publish/x");
      await center.locator('[data-template-key^="builtin:channel-template:technical:"]').click();
      await preview.locator('[data-template-detail="preview"]:enabled').click();
      await previewFrame("builtin-channel");
      assert.match(await preview.locator("iframe").getAttribute("srcdoc"), /A place for clear ideas/);
      await preview.locator(".template-detail-preview select").selectOption("x-thread");
      await preview.locator(".library-post").first().waitFor();
      const downloadPending = page.waitForEvent("download");
      await preview.locator('[data-template-detail="export"]').click();
      const download = await downloadPending;
      const exported = JSON.parse(await readFile(await download.path(), "utf8"));
      assert.equal(exported.manifest.id, "custom.technical");
      await verifyPluginPackage(exported);
      assert.doesNotMatch(JSON.stringify(exported), /password|auth\.json|fixture-owner|visibility-test/);
      await preview.locator('[data-template-detail="edit"]').click();
      await library.locator("#library-id").waitFor();
      assert.equal(await library.locator("#library-id").inputValue(), "custom.technical");
      await library.locator("#library-id").fill("custom.technical-" + width);
      await library.locator("[data-library-archive] > summary").click();
      await library.locator("#library-archive-author").fill("Fixture author");
      await library.locator("#library-archive-license").fill("MIT");
      await library.locator('[data-style-field="size"]').selectOption("20px");
      await library.locator('[data-style-field="width"]').selectOption("760px");
      await library.locator('[data-library-action="save"]').click();
      await library.locator('[data-library-action="preview"]:enabled').waitFor();
      await library.locator('[data-library-action="preview"]').click();
      await library.locator("#libraryPreview iframe").waitFor();
      assert.match(await library.locator("#libraryPreview iframe").getAttribute("srcdoc"), /font-size:20px/);
      const draftState = await context.request.get(fixture.base + "/api/template-library");
      const drafts = (await draftState.json()).drafts;
      assert.equal(
        drafts.find((draft) => draft.manifest.id === "custom.technical-" + width).manifest.channelTemplates[0].style
          .width,
        "760px",
      );
      await library.locator('[data-library-action="close"]').click();
      const discard = library.locator('[data-library-action="discard"]');
      if (await discard.isVisible()) await discard.click();
      await library.waitFor({ state: "hidden" });
      const imported = structuredClone(exported);
      imported.manifest.id += "-" + width;
      await page.goto(fixture.base + "/settings/plugins-settings");
      await page.locator("[data-extension-manage]").click();
      const packages = page.locator("#settingsExtensionManager");
      await packages.locator("#packageFile").setInputFiles({
        name: "style.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(imported)),
      });
      await packages.locator('[data-package-action="review"]').click();
      await packages.locator("#packageAccept").check();
      await packages.locator("#packageApproval button[type=submit]").click();
      await packages.locator('[data-package-action="close"]').click();
      await page.goto(fixture.base + "/publish/x");
      const importedKey = `presentation:channel-template:${imported.manifest.id}:style:1.0.0:`;
      await center.locator(`[data-template-key^="${importedKey}"]`).waitFor();
      await center.locator("[data-template-search]").fill(imported.manifest.id);
      await page.waitForFunction(() => document.querySelectorAll(".template-manager .template-card").length === 1);
      await center.locator(`[data-template-key^="${importedKey}"]`).click();
      await preview.locator('[data-template-detail="preview"]:enabled').click();
      await previewFrame("installed-channel");
      const roundtripPending = page.waitForEvent("download");
      await preview.locator('[data-template-detail="export"]').click();
      const roundtrip = await roundtripPending;
      assert.deepEqual(
        JSON.parse(await readFile(await roundtrip.path(), "utf8")),
        (await verifyPluginPackage(imported)).package,
      );
      await preview.locator('[data-template-detail="edit"]').click();
      await library.locator("#library-version").waitFor();
      assert.equal(await library.locator("#library-version").inputValue(), "1.0.1");
      await library.locator('[data-library-action="close"]').click();
      await library.locator('[data-library-action="discard"]').click();
      await library.waitFor({ state: "hidden" });
      await center.locator("[data-template-search]").fill("");
      await page.goto(fixture.base + "/publish/website");
      await center.locator(".template-card").first().waitFor();
      await mkdir(".artifacts/publishing-styles", { recursive: true });
      await page.screenshot({ path: `.artifacts/publishing-styles/gallery-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.doesNotMatch(await center.textContent(), /plugins\.styles|shell\.preferences/);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await context.close();
      console.log(
        `${engine.name()} ${width}: visual settings, fixed samples, editable copy and reviewed package round-trip passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
