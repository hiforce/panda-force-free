import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { profileThemePackage } from "../support/profile-theme-package.js";
import { templateDefinition } from "../../src/client/plugins/library/defaults.js";

const executor = await createSampleExecutorHttp();
const fixture = await createAppFixture({
  extraEnvironment({ dir }) {
    const tokenFile = join(dir, "sample-token");
    writeFileSync(tokenFile, executor.token, { mode: 0o600 });
    return { PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url, PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: tokenFile };
  },
});
try {
  for (const [browserEngine, width, locale, engine, theme] of [
    [chromium, 1440, "en", "hexo", "panda.reader"],
    [webkit, 390, "zh-CN", "docusaurus", "panda.handbook"],
  ]) {
    const browser = await browserEngine.launch({
      headless: true,
      ...(browserEngine === chromium ? { args: ["--no-sandbox"] } : {}),
    });
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 500 ? "dark" : "light",
      });
      await fixture.signIn(context);
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [],
        external = [],
        posted = [];
      let loseResponse = true,
        observed = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (!request.url().startsWith(fixture.base)) external.push(request.url());
      });
      page.on("response", (response) => {
        if (response.url().includes("/api/site-samples/detail?")) observed++;
      });
      await page.route("**/api/site-samples", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posted.push(route.request().postDataJSON().id);
        if (!loseResponse) return route.continue();
        loseResponse = false;
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 202);
        await route.abort("failed");
      });
      const open = async () => {
        await page.goto(fixture.base + "/publish/website");
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator(`[data-publish-format="${engine}"]`).click();
        const center = page.locator(".template-manager");
        await center.locator(".template-card").first().waitFor();
        await center.locator(`[data-template-key^="builtin:site-theme:${theme}:"]`).click();
        const detail = page.locator("#managedTemplateDialog");
        await detail.locator('[data-template-detail="preview"]:enabled').click();
        await detail.locator(".template-static-sample > summary").click();
        return detail;
      };
      console.log(`${browserEngine.name()} ${width}: gallery and response-loss recovery`);
      let preview = await open(),
        monitor = preview.locator(".site-sample-monitor");
      await monitor.locator('[data-sample-action="start"]:enabled').waitFor();
      await monitor.locator('[data-sample-action="start"]').click();
      await monitor.locator('[data-sample-action="start"]:enabled').waitFor();
      assert.equal(
        await monitor.locator('[data-sample-action="start"]').textContent(),
        locale === "en" ? "Retry build request" : "重试构建请求",
      );
      await monitor.locator('[data-sample-action="start"]').click();
      await monitor.locator('[data-sample-status][data-phase="running"]').waitFor();
      assert.equal(posted[0], posted[1]);
      const first = posted[0],
        frame = await monitor.locator("iframe").elementHandle();
      const before = observed;
      await waitFor(() => observed >= before + 2);
      assert.equal(
        await frame.evaluate((node) => node.isConnected),
        true,
        "Polling preserves the existing illustration frame",
      );
      assert.equal([...executor.inputs.keys()].filter((id) => id === first).length, 1);
      preview = await open();
      monitor = preview.locator(".site-sample-monitor");
      await monitor.locator('[data-sample-status][data-phase="running"]').waitFor();
      assert.equal(posted.length, 2, "Reopening observes the persisted job without a new request");
      executor.release(first);
      const actual = monitor.locator('iframe[srcdoc*="#123456"]');
      await actual.waitFor();
      assert.equal(await actual.getAttribute("sandbox"), "");
      const content = await (await actual.elementHandle()).contentFrame();
      assert.equal(await content.locator("h1").evaluate((node) => getComputedStyle(node).color), "rgb(18, 52, 86)");
      assert.equal(await content.locator("script").count(), 0);
      mkdirSync(".artifacts/site-samples", { recursive: true });
      await page.screenshot({ path: `.artifacts/site-samples/preview-${width}.png` });
      await monitor.locator("[data-sample-preview] select").selectOption("sample/index.html");
      await monitor.locator('iframe[srcdoc*="A sample page"]').waitFor();

      console.log(
        `${browserEngine.name()} ${width}: multi-page CSS preview verified; importing a fixed theme definition`,
      );
      assert.equal(await preview.locator('[data-template-detail="edit"]').isVisible(), false);
      await preview.locator('[data-template-detail="close"]').click();
      let releaseLibrary;
      const libraryReady = new Promise((resolve) => {
        releaseLibrary = resolve;
      });
      let initialLibrary = true,
        libraryLoading = false;
      await page.route(fixture.base + "/api/template-library", async (route) => {
        if (route.request().method() === "GET" && initialLibrary) {
          initialLibrary = false;
          libraryLoading = true;
          await libraryReady;
        }
        await route.continue();
      });
      await page.locator(".template-manager [data-template-menu] summary").click();
      await page.locator('.template-manager [data-template-action="drafts"]').click();
      const library = page.locator("#managedPublishingDrafts"),
        packageId = "example.web-" + width;
      const imported = profileThemePackage();
      imported.manifest.id = packageId;
      imported.manifest.siteThemes = imported.manifest.siteThemes.filter((theme) => theme.engine === engine);
      imported.manifest.siteThemes[0].profile.width = 960;
      const definition = templateDefinition(imported);
      definition.archive.author = "Sample author";
      definition.archive.license = "MIT";
      definition.archive.licenseText = "A disposable test license.";
      await waitFor(() => libraryLoading);
      try {
        await library.locator("#libraryImport").setInputFiles({
          name: "site-definition.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify({ definition })),
        });
        assert.equal(await library.getAttribute("aria-busy"), "true");
      } finally {
        releaseLibrary();
      }
      await library.locator("#library-id").waitFor();
      assert.equal(await library.locator("#library-id").inputValue(), packageId);
      assert.equal(await library.locator("[data-theme-field]").count(), 0);
      await library.locator('[data-library-action="preview"]:enabled').waitFor();
      await page.unroute(fixture.base + "/api/template-library");
      const selectedDrafts = await context.request.get(fixture.base + "/api/template-library");
      assert.equal((await selectedDrafts.json()).drafts.filter((draft) => draft.manifest.id === packageId).length, 1);
      await library.locator('[data-library-action="preview"]').click();
      await library.locator('[data-library-action="review-sample"]:enabled').waitFor();
      console.log(`${browserEngine.name()} ${width}: reviewing sample execution package`);
      await library.locator('[data-library-action="review-sample"]').click();
      await library.locator("#librarySamplePackageAccept").check();
      await library.locator("#librarySamplePackageApproval button[type=submit]").click();
      monitor = library.locator(".site-sample-monitor");
      await monitor.locator('[data-sample-action="start"]:enabled').waitFor();
      await monitor.locator('[data-sample-action="start"]').click();
      await waitFor(() => [...executor.gates.keys()].some((id) => id !== first));
      const second = [...executor.gates.keys()][0];
      assert.equal(executor.inputs.get(second).theme.package.id, packageId);
      assert.equal(executor.inputs.get(second).theme.profile.width, 960);
      executor.release(second);
      await library.locator('[data-library-action="baseline"]:enabled').waitFor();
      await library.locator('[data-library-action="baseline"]').click();
      await library.locator('[data-library-action="preview"]:enabled').waitFor();
      await library.locator('[data-library-action="preview"]').click();
      await library.locator('iframe[srcdoc*="#123456"]').waitFor();
      console.log(`${browserEngine.name()} ${width}: accepted sample baseline; validating archive`);
      await library.locator('[data-library-action="validate"]').click();
      await library.locator('[data-library-action="review"]:enabled').waitFor();
      await library.locator('[data-library-action="review"]').click();
      await library.locator("#libraryPackageAccept").check();
      const archivedResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/template-library/publish") && response.request().method() === "POST",
      );
      await library.locator("#libraryPackageApproval button[type=submit]").click();
      const receipt = await archivedResponse;
      assert.equal(receipt.status(), 201);
      assert.equal((await receipt.json()).release.id, packageId);
      await library.locator("#library-version:disabled").waitFor();
      const releases = await context.request.get(fixture.base + "/api/template-library");
      const archived = (await releases.json()).releases.find((item) => item.id === packageId);
      assert.equal(archived.validation.passed, true);
      assert.equal(archived.version, "1.0.0");
      mkdirSync(".artifacts/site-samples", { recursive: true });
      await page.screenshot({ path: `.artifacts/site-samples/library-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.doesNotMatch(await library.textContent(), /plugins\.sample|plugins\.styles|shell\.preferences/);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await context.close();
      console.log(
        `${browserEngine.name()} ${width}: persisted website sample, response-loss recovery, stable polling, CSS preview and template archive passed`,
      );
    } catch (error) {
      mkdirSync(".artifacts/site-samples", { recursive: true });
      if (page && !page.isClosed()) await page.screenshot({ path: `.artifacts/site-samples/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
  await executor.stop();
}
