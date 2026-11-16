import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeFiles, nativeZipSource } from "../support/native-theme.js";

const evidence = ".artifacts/template-archive-entry";
await mkdir(evidence, { recursive: true });
for (const [browserType, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
]) {
  const app = await createAppFixture();
  const browser = await browserType.launch({
    headless: true,
    ...(browserType === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    await app.signIn(context);
    page = await context.newPage();
    await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
    const errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
    });
    await page.goto(app.base + "/publish/website");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    const center = page.locator(".template-manager");
    const importer = page.locator("#managedTemplateImport");
    const source = page.locator("#sourceTemplateImport");
    const form = source.locator("[data-source-native-review]");
    const privateArchive = process.env.PANDA_FORCE_TEST_NATIVE_TEMPLATE_ARCHIVE;
    const archive = privateArchive
      ? new Uint8Array(await readFile(privateArchive))
      : (
          await nativeZipSource({
            ...nativeFiles,
            "theme/package.json": JSON.stringify({
              name: "example-theme",
              version: "1.0.0",
              author: "Example publisher",
              license: "MIT",
            }),
          })
        ).bytes;
    await center.locator('[data-template-action="import"]').click();
    await importer.locator("[data-import-file]").setInputFiles({
      name: "editorial.native-theme.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive),
    });
    await importer.waitFor({ state: "hidden" });
    await source.locator('[data-source-candidate="hexo-theme"] [data-source-choose]').click();
    await form.locator('[data-native-field="id"]:enabled').waitFor();
    const id = privateArchive
      ? await form.locator('[data-native-field="id"]').inputValue()
      : `example.archive-${width}`;
    if (!privateArchive) await form.locator('[data-native-field="id"]').fill(id);
    const version = await form.locator('[data-native-field="version"]').inputValue();
    await form.locator("[data-native-settings] button[type=submit]").click();
    await form.locator("[data-native-code]:enabled").waitFor();
    assert.equal(await form.locator("[data-native-accept]").evaluate((node) => node.checkValidity()), false);
    await form.locator("[data-native-code]").check();
    assert.equal(await form.locator("[data-native-accept]").evaluate((node) => node.checkValidity()), false);
    await form.locator("[data-native-license]").check();
    if (privateArchive) assert.match(await form.locator("[data-native-approval]").innerText(), /UNLICENSED/);
    await page.screenshot({ path: `${evidence}/approval-${width}.png` });
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/templates/native/install") && r.request().method() === "POST",
    );
    await form.locator("[data-native-accept] button[type=submit]").click();
    const installed = await response;
    assert.equal(installed.status(), 201, await installed.text());
    await form.locator("[data-native-accept]").waitFor({ state: "hidden" });
    await source.locator('[data-source-action="close"]').click();
    await center.locator(`[data-template-key^="native:site-theme:${id}:${version}:"]`).click();
    const detail = page.locator("#managedTemplateDialog");
    await detail.locator('[data-template-detail="export"]:enabled').waitFor();
    const download = page.waitForEvent("download");
    await detail.locator('[data-template-detail="export"]').click();
    const exported = unzipSync(new Uint8Array(await readFile(await (await download).path())));
    assert.ok(Object.keys(exported).some((key) => key.startsWith("theme/")));
    await detail.locator('[data-template-detail="close"]').click();
    // Closing during policy acquisition must not resurrect an old selected archive.
    let releasePolicy;
    await page.route("**/api/package-sources/policy**", async (route) => {
      await new Promise((resolve) => {
        releasePolicy = resolve;
      });
      await route.continue().catch((error) => assert.match(error.message, /already handled|cancel|closed/));
    });
    await center.locator('[data-template-action="import"]').click();
    await importer.locator("[data-import-file]").setInputFiles({
      name: "cancelled.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive),
    });
    await source.locator('[data-source-action="close"]').click();
    if (releasePolicy) releasePolicy();
    await page.unroute("**/api/package-sources/policy**");
    await center.locator('[data-template-action="import"]').click();
    await importer.locator("[data-import-file]").setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from("invalid JSON"),
    });
    await importer.locator('[data-import-notice][data-error="true"]').waitFor();
    assert.equal(await source.isVisible(), false);
    await importer.locator('[data-import-action="close"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await page.screenshot({ path: `${evidence}/installed-${width}.png` });
    console.log(
      `${browserType.name()} ${width}: ordinary archive import, explicit approvals, native install/export, closed handoff and JSON errors passed`,
    );
  } catch (error) {
    if (page) await page.screenshot({ path: `${evidence}/failure-${width}.png` });
    throw error;
  } finally {
    await browser.close();
    await app.dispose();
  }
}
