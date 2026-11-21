import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-loading";
await mkdir(out, { recursive: true });
const records = [];
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture({
    applicationCreation: true,
    models: [
      {
        id: "fixture",
        model: "fixture",
        isDefault: true,
        displayName: "Fixture",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        defaultReasoningEffort: "medium",
      },
    ],
  });
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale,
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await app.signIn(context);
    await context.addInitScript((locale) => {
      if (/^https?:$/.test(location.protocol)) {
        localStorage.setItem("panda-force-theme", "dark");
        localStorage.setItem("panda-force-locale", locale);
      }
    }, locale);
    await context.request.post(app.base + "/api/system/database/selection", {
      data: { driver: "sqlite" },
      headers: { Origin: app.base },
    });
    const page = await context.newPage(),
      requests = [],
      errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.route("**/api/skill-workspace?view=categories", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ messageId: "skillWorkspace.unavailable" }),
      }),
    );
    await page.goto(app.base + "/workspace");
    await page.locator("[data-gd-skills]:enabled").waitFor();
    await page.locator("[data-gd-skills]").click();
    const picker = page.locator(".creation-skill-browser[open]");
    await picker.locator('[data-skill-id="software-prd"]:enabled').waitFor();
    await picker.locator("[data-skill-category-retry]").waitFor();
    assert.equal(await picker.locator(".creation-skill-options").getAttribute("aria-busy"), "false");
    assert.equal(await picker.locator('[data-skill-category="all"]').getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: `${out}/category-recovery-${width}-${locale}.png` });
    await picker.locator('[data-skill-id="software-prd"]').click();
    await picker.locator("footer [data-skill-browser-close]").click();
    let release;
    const paused = new Promise((resolve) => (release = resolve));
    await page.route("**/api/project-document-tree?*", async (route) => {
      await paused;
      await route.continue();
    });
    await page.route("**/api/personal/project-document-tree?*", async (route) => {
      await paused;
      await route.continue();
    });
    await page.locator("#gadgetDocumentPrompt").fill("编写商品资料平台的需求说明。");
    await page.locator("[data-gd-start]").click();
    await page.locator(".creation-dialog[open] [data-creation-close]").waitFor({ timeout: 1000 });
    assert(
      !requests.some((url) => url.includes("/document-creations/detail")),
      "Neither list nor pending preparation may preload conversation history",
    );
    await page.locator(".creation-dialog[open] [data-creation-close]").click();
    release();
    await page.locator("[data-gd-start]:enabled").waitFor();
    assert.equal(await page.locator(".creation-dialog[open]").count(), 0);
    assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "编写商品资料平台的需求说明。");
    const headers = { Origin: app.base };
    const options = await (await context.request.get(app.base + "/api/personal/document-creations/options")).json();
    const id = crypto.randomUUID();
    const submitted = await context.request.post(app.base + "/api/personal/document-creations", {
      headers,
      data: {
        id,
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        locale: "zh-CN",
        prompt: "缓存优先的创作测试",
        profileId: options.defaultProfileId,
        selections: [options.defaultWorkflow],
      },
    });
    assert.equal(submitted.status(), 202);
    let releaseRead;
    let held = new Promise((resolve) => (releaseRead = resolve));
    await page.route("**/document-creations/detail?*", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
    await page.waitForFunction(() => !document.body.classList.contains("workspace-booting"));
    await page.locator('.creation-session-notice[data-phase="loading"]').waitFor({ timeout: 1000 });
    await page.screenshot({ path: `${out}/initial-indicator-${width}-${locale}.png` });
    releaseRead();
    const message = page.locator("#conversation .user-message").first();
    await message.waitFor();
    await page.locator(".creation-session-status .user-input-card").waitFor();
    await page.locator("#prompt").fill("保留等待网络恢复时的新输入");
    held = new Promise((resolve) => (releaseRead = resolve));
    await page.reload();
    await page.waitForFunction(() => !document.body.classList.contains("workspace-booting"));
    await message.waitFor({ timeout: 1000 });
    await page.locator('.creation-session-notice[data-phase="refreshing"]').waitFor({ timeout: 1000 });
    assert.equal(await page.locator("#prompt").inputValue(), "保留等待网络恢复时的新输入");
    await page.screenshot({ path: `${out}/cached-indicator-${width}-${locale}.png` });
    releaseRead();
    await page.locator('.creation-session-notice[data-phase="idle"]').waitFor({ state: "hidden" });
    const retained = await message.elementHandle();
    let releaseBackground;
    const waiting = new Promise((resolve) => (releaseBackground = resolve));
    const hold = async (route) => {
      await waiting;
      await route.continue();
    };
    await page.route("**/document-creations/detail?*", hold);
    const before = await message.boundingBox();
    await page.waitForRequest((request) => request.url().includes("/document-creations/detail?"), { timeout: 6000 });
    await page.waitForTimeout(250);
    assert.equal(
      await page
        .locator('.creation-session-notice[data-phase="loading"],.creation-session-notice[data-phase="refreshing"]')
        .isVisible(),
      false,
    );
    const during = await message.boundingBox();
    assert(Math.abs(before.y - during.y) < 2, "Background polling must not replace content with a loading layout");
    releaseBackground();
    await page.unroute("**/document-creations/detail?*", hold);
    let failed = false;
    const fail = (route) => {
      if (!failed) {
        failed = true;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ messageId: "creation.unavailable" }),
        });
      }
      return route.continue();
    };
    await page.route("**/document-creations/detail?*", fail);
    await page.waitForResponse(
      (response) => response.url().includes("/document-creations/detail?") && response.status() === 503,
      { timeout: 6000 },
    );
    assert(await retained.evaluate((node) => node.isConnected), "A transient read failure preserves visible history");
    await page.locator(".creation-session-notice button").click();
    await page.waitForResponse(
      (response) => response.url().includes("/document-creations/detail?") && response.status() === 200,
      { timeout: 6000 },
    );
    assert(await retained.evaluate((node) => node.isConnected), "Recovery preserves stable message nodes");
    await page.unroute("**/document-creations/detail?*", fail);
    await page.goto(app.base + "/create");
    await page.locator(`[data-activity-task="${id}"]`).first().waitFor();
    await page.evaluate((id) => {
      for (const key of Object.keys(sessionStorage))
        if (
          key.startsWith("panda-force-creation-snapshot:") &&
          key.includes(encodeURIComponent("conversation:creation:personal:" + id))
        )
          sessionStorage.removeItem(key);
    }, id);
    held = new Promise((resolve) => (releaseRead = resolve));
    await page.locator(`[data-activity-task="${id}"]`).first().click();
    await message.filter({ hasText: "缓存优先的创作测试" }).waitFor({ timeout: 1000 });
    await page.locator('.creation-session-notice[data-phase="refreshing"]').waitFor({ timeout: 1000 });
    releaseRead();
    await page.locator(".creation-session-status .user-input-card").waitFor();
    const deny = (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ messageId: "creation.unavailable" }),
      });
    await page.route("**/document-creations/detail?*", deny);
    await page.reload();
    await page.locator('.creation-session-notice[data-phase="error"]').waitFor();
    assert.equal(await page.locator("#conversation .user-message").count(), 0, "Revoked access clears cached history");
    assert.equal(await page.locator("[data-creation-open]:visible").count(), 0);
    await page.unroute("**/document-creations/detail?*", deny);
    await page.locator(".creation-session-notice button").click();
    await message.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    records.push({
      width,
      locale,
      categoriesFailureKeepsSkillsSelectable: true,
      progressFrameBeforeSlowPreparation: true,
      cancelledPreparationDoesNotSubmit: true,
      initialLoadingIndicator: true,
      cachedHistoryDuringRefresh: true,
      listSnapshotBeforeDetailResponse: true,
      deniedRefreshClearsCachedContentAndRecovers: true,
      backgroundRefreshPreservesGeometryAndNodes: true,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
