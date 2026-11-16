import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-loading";
await mkdir(out, { recursive: true });
const records = [];
for (const [engine, width] of [
  [chromium, 1440],
  [webkit, 390],
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
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "zh-CN" });
    await app.signIn(context);
    await context.addInitScript(() => {
      if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
    });
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
    await page.screenshot({ path: `${out}/category-recovery-${width}.png` });
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
    let refreshRelease;
    let refreshPaused = new Promise((resolve) => (refreshRelease = resolve));
    let historyRelease;
    const historyPaused = new Promise((resolve) => (historyRelease = resolve));
    await page.route("**/document-creations/detail?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("view") === "progress") await refreshPaused;
      else await historyPaused;
      await route.continue();
    });
    await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
    await page.locator('[data-detail-loading][data-phase="loading"]:visible').waitFor({ timeout: 1000 });
    await page.screenshot({ path: `${out}/initial-indicator-${width}.png` });
    refreshRelease();
    await page.locator(".creation-detail-page [data-detail-meta]").filter({ hasText: /个人/ }).waitFor();
    await page.locator("[data-detail-loading]").waitFor({ state: "hidden" });
    refreshPaused = new Promise((resolve) => (refreshRelease = resolve));
    await page.reload();
    await page
      .locator(".creation-detail-page [data-detail-meta]")
      .filter({ hasText: /个人/ })
      .waitFor({ timeout: 1000 });
    assert.equal(await page.locator("[data-detail-notice]").innerText(), "");
    await page.locator('[data-detail-loading][data-phase="refreshing"]:visible').waitFor({ timeout: 1000 });
    await page.screenshot({ path: `${out}/cached-indicator-${width}.png` });
    assert(
      !requests.some((url) => url.includes("/document-creations/detail") && !new URL(url).searchParams.has("view")),
      "Restoring cached progress must not load chat history",
    );
    refreshRelease();
    await page.locator('[data-detail-tab="conversation"]').click();
    await page.locator('[data-detail-loading][data-phase="history"]:visible').waitFor();
    historyRelease();
    await page.locator('[data-conversation-role="user"]').waitFor();
    await page.locator("[data-detail-loading]").waitFor({ state: "hidden" });
    await page.screenshot({ path: `${out}/conversation-${width}.png`, fullPage: true });
    const historyReads = requests.filter(
      (url) => url.includes("/document-creations/detail") && !new URL(url).searchParams.has("view"),
    ).length;
    await page.goto(app.base + "/create");
    await page.locator(`[data-activity-task="${id}"]`).waitFor();
    await page.evaluate((id) => {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("panda-force-creation-snapshot:") && key.endsWith(encodeURIComponent("personal:" + id)))
          sessionStorage.removeItem(key);
    }, id);
    refreshPaused = new Promise((resolve) => (refreshRelease = resolve));
    await page.locator(`[data-activity-task="${id}"]`).click();
    await page.locator("[data-detail-excerpt]").filter({ hasText: "缓存优先的创作测试" }).waitFor({ timeout: 1000 });
    await page.locator('[data-detail-loading][data-phase="refreshing"]:visible').waitFor({ timeout: 1000 });
    assert.equal(
      requests.filter((url) => url.includes("/document-creations/detail") && !new URL(url).searchParams.has("view"))
        .length,
      historyReads,
    );
    refreshRelease();
    await page.locator("[data-detail-loading]").waitFor({ state: "hidden" });
    const deny = (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ messageId: "creation.unavailable" }),
      });
    await page.route("**/document-creations/detail?*", deny);
    await page.reload();
    await page.locator(".creation-detail-layout").waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-detail-open]:visible").count(), 0);
    assert.equal(await page.locator("[data-detail-meta]").innerText(), "");
    await page.unroute("**/document-creations/detail?*", deny);
    await page.locator("[data-detail-notice] button").click();
    await page.locator(".creation-detail-layout").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    records.push({
      width,
      categoriesFailureKeepsSkillsSelectable: true,
      progressFrameBeforeSlowPreparation: true,
      cancelledPreparationDoesNotSubmit: true,
      noConversationPrefetch: true,
      initialLoadingIndicator: true,
      cachedProgressDuringRefresh: true,
      onDemandConversationIndicator: true,
      listSnapshotBeforeDetailResponse: true,
      deniedRefreshClearsCachedContentAndRecovers: true,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.stop();
  }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
