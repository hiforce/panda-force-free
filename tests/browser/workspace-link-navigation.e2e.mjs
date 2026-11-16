import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit, devices } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/workspace-link-navigation";
await mkdir(out, { recursive: true });
const results = [];
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
]) {
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
    browser = await engine.launch(),
    context = await browser.newContext({
      ...(engine === webkit ? devices["iPhone 13"] : {}),
      viewport: { width, height: 960 },
      locale,
    });
  let release, debugPage;
  const gate = new Promise((resolve) => (release = resolve));
  try {
    await context.addInitScript(
      (theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      },
      width > 700 ? "silk" : "aurora",
    );
    await app.signIn(context);
    await context.request.post(app.base + "/api/system/database/selection", {
      data: { driver: "sqlite" },
      headers: { Origin: app.base },
    });
    const page = await context.newPage(),
      errors = [],
      documentRequests = [];
    debugPage = page;
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.base + "/create");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator("#gadgetDocumentPrompt").fill("Keep my brief while I manage skills.");
    await page.locator("[data-gd-skills]").click();
    const picker = page.locator(".creation-skill-browser[open]");
    await picker.locator(".creation-skill-option").first().waitFor();
    assert.equal(await picker.locator("[data-skill-category]").first().getAttribute("data-skill-category"), "all");
    assert.equal(await picker.locator('[data-skill-category="writing"]').getAttribute("aria-pressed"), "true");
    assert.equal(await picker.locator('[data-skill-category="all"]').getAttribute("aria-pressed"), "false");
    assert.deepEqual(
      await picker
        .locator("[data-skill-category]")
        .evaluateAll((buttons) => buttons.map((button) => button.dataset.skillCategory)),
      ["all", "writing", "research", "slides", "image", "web", "video"],
    );
    await page.screenshot({ path: `${out}/configured-category-picker-${width}.png`, scale: "css" });
    await page.evaluate(() => {
      globalThis.__navigationDocument = crypto.randomUUID();
      globalThis.__preparationReopened = false;
      new MutationObserver(() => {
        if (!document.getElementById("workspacePreparation").hidden) globalThis.__preparationReopened = true;
      }).observe(document.getElementById("workspacePreparation"), { attributes: true });
    });
    const identity = await page.evaluate(() => globalThis.__navigationDocument);
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push(request.url());
    });
    let failCatalog = false;
    await page.route("**/api/template-catalog?*", async (route) => {
      await gate;
      if (failCatalog) return route.fulfill({ status: 503, json: { messageId: "plugins.packageUnavailable" } });
      await route.continue();
    });
    const manage = picker.locator('a[href="/skills/writing"]');
    if (width > 700) {
      await manage.focus();
      await page.keyboard.press("Enter");
    } else await manage.tap();
    await page.waitForURL("**/skills/writing");
    await page.locator(".skills-workspace h1").waitFor();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(await page.locator(".template-manager").getAttribute("aria-busy"), "true");
    await page.screenshot({ path: `${out}/loading-${width}.png` });
    assert.equal(await page.evaluate(() => globalThis.__navigationDocument), identity);
    assert.equal(await page.locator("#workspacePreparation").isVisible(), false);
    release();
    await page.locator(".template-card").first().waitFor();
    await page.screenshot({ path: `${out}/skills-${width}.png` });
    await page.goBack();
    await page.waitForURL("**/create");
    assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "Keep my brief while I manage skills.");
    await page.screenshot({ path: `${out}/returned-${width}.png` });
    await page.goForward();
    await page.waitForURL("**/skills/writing");
    await page.locator(".template-card").first().waitFor();
    failCatalog = true;
    await page.locator('[data-template-action="refresh"]').click();
    await page.locator('[data-template-notice][data-error="true"]').waitFor();
    assert.equal(await page.locator("#workspacePreparation").isVisible(), false);
    failCatalog = false;
    await page.locator('[data-template-action="refresh"]').click();
    await page.waitForFunction(
      () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
    );
    await page.locator(".template-card").first().waitFor();
    for (const route of ["projects", "tasks", "create", "skills"]) {
      await page
        .locator(width > 700 ? `#sidebar [data-route="${route}"]` : `.workbench-mobile-nav [data-route="${route}"]`)
        .click();
      await page.waitForURL("**/" + route);
    }
    await page.locator(".template-card").first().waitFor();
    assert.equal(
      await page
        .locator('[data-skills-select] option[value="site"], [data-skills-select] option[value="channel"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator(
          '[data-template-type] option[value="panda.site-theme"], [data-template-type] option[value="panda.channel-format"]',
        )
        .count(),
      0,
    );
    await page.screenshot({ path: `${out}/skills-only-${width}.png`, scale: "css" });
    await page
      .locator(width > 700 ? '#sidebar [data-route="publish"]' : '.workbench-mobile-nav [data-route="publish"]')
      .click();
    await page.locator('[data-publish-channel="website"]').click();
    await page.locator(".template-card").first().waitFor();
    assert.ok(
      (
        await page.locator(".template-card").evaluateAll((cards) => cards.map((card) => card.dataset.templateKey))
      ).every((key) => key.includes(":site-theme:")),
    );
    await page.screenshot({ path: `${out}/publishing-site-${width}.png`, scale: "css" });
    assert.doesNotMatch(await page.locator("[data-publish-templates]").innerText(), /skills?|技能/i);
    await page.locator(".template-card").first().click();
    const resourceDetail = page.locator("#managedTemplateDialog[open]");
    await resourceDetail.locator('[data-template-detail="export"]:visible:enabled').waitFor();
    assert.doesNotMatch(await resourceDetail.innerText(), /skills?|技能/i);
    await page.keyboard.press("Escape");
    await page.locator('a.resource-back[href="/publish"]').click();
    await page.locator('[data-publish-channel="x"]').click();
    await page.locator(".template-card").first().waitFor();
    assert.ok(
      (
        await page.locator(".template-card").evaluateAll((cards) => cards.map((card) => card.dataset.templateKey))
      ).every((key) => key.includes(":channel-template:")),
    );
    await page.screenshot({ path: `${out}/publishing-channel-${width}.png`, scale: "css" });
    assert.doesNotMatch(await page.locator("[data-publish-templates]").innerText(), /skills?|技能/i);
    await page.locator(".template-card").first().click();
    await resourceDetail.locator('[data-template-detail="export"]:visible:enabled').waitFor();
    assert.doesNotMatch(await resourceDetail.innerText(), /skills?|技能/i);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => globalThis.__navigationDocument), identity);
    assert.equal(await page.evaluate(() => globalThis.__preparationReopened), false);
    assert.deepEqual(
      documentRequests,
      [],
      "Internal links must not restart the HTML document or application bootstrap",
    );
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({
      engine: engine.name(),
      width,
      documentRequests,
      preparationReopened: false,
      briefRestored: true,
      localReadRecovery: true,
      publishingResourcesSeparated: true,
    });
  } catch (error) {
    if (debugPage) {
      await debugPage.screenshot({ path: `${out}/failure-${width}.png` });
      console.error(
        "Publication detail at",
        debugPage.url(),
        await debugPage.locator("#managedTemplateDialog").allTextContents(),
      );
    }
    console.error(error);
    throw error;
  } finally {
    release();
    await context.close();
    await browser.close();
    await app.dispose();
  }
}
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2) + "\n");
