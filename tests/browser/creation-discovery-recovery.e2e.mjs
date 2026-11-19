import { openComposerSettings } from "../support/composer-settings.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-discovery-recovery";
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
    startupTimeoutMs: 90000,
    prepareState: async ({ dir }) => {
      await writeFile(
        dir + "/history.jsonl",
        Array.from(
          { length: 1000 },
          (_, i) => JSON.stringify({ session_id: "old-alpha", text: `Saved input ${i}` }) + "\n",
        ).join(""),
      );
    },
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
      if (window !== window.top || !/^https?:$/.test(location.protocol)) return;
      localStorage.setItem("panda-force-theme", "aurora");
      localStorage.setItem("panda-force-locale", locale);
      globalThis.__pandaForceTest = true;
    }, locale);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failSkills = true,
      failCategories = true,
      writes = 0,
      historyReads = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.includes("/document-creations")) writes++;
    });
    await page.route("**/api/skill-packs?*", (route) =>
      failSkills
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ messageId: "skills.unavailable" }),
          })
        : route.continue(),
    );
    await page.route("**/api/skill-workspace?view=categories", (route) =>
      failCategories
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ messageId: "skillWorkspace.unavailable" }),
          })
        : route.continue(),
    );
    let releaseHistory;
    const historyHeld = new Promise((resolve) => {
      releaseHistory = resolve;
    });
    await page.route("**/api/composer/history?*", async (route) => {
      historyReads++;
      if (historyReads === 1) await historyHeld;
      await route.continue();
    });
    await page.goto(app.base + "/create", { waitUntil: "domcontentloaded" });
    const discovery = page.locator(".creation-skill-discovery");
    await discovery.locator("[data-discovery-notice] button").waitFor();
    await discovery.locator("[data-skill-category-retry]").waitFor();
    assert.equal(
      await discovery.locator(".creation-skill-picker-hint").count(),
      0,
      "A failed read is not an empty installed catalog",
    );
    assert.equal(
      await discovery.locator("[data-discovery-more]").isVisible(),
      false,
      "No cursor means no pagination action",
    );
    const draft = "Keep the creation draft while catalog reads recover " + locale;
    await page.locator("#prompt").fill(draft);
    await discovery.locator("input[type=search]").fill("software");
    await page.screenshot({ path: `${out}/failed-${width}-${locale}.png`, fullPage: true });
    failSkills = false;
    failCategories = false;
    await discovery.locator("[data-discovery-notice] button").click();
    await discovery.locator("[data-skill-category-retry]").click();
    await discovery.locator("[data-skill-id=software-prd]").waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".creation-skill-discovery [data-skill-category]").length > 1,
    );
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    assert.equal(await discovery.locator("input[type=search]").inputValue(), "software");
    assert.equal(await discovery.locator("[data-discovery-notice]").innerText(), "");
    assert.equal(await discovery.locator("[data-discovery-more]").isVisible(), false);
    await discovery.locator("input[type=search]").fill("");
    const categoryResponse = await context.request.get(app.base + "/api/skill-workspace?view=categories");
    const catalogResponse = await context.request.get(app.base + "/api/skill-packs?view=available&limit=50");
    assert.equal(categoryResponse.status(), 200);
    assert.equal(catalogResponse.status(), 200);
    assert.match(categoryResponse.headers()["server-timing"], /^skill-workspace;dur=\d+\.\d{2}, app;dur=\d+\.\d{2}$/);
    assert.match(catalogResponse.headers()["server-timing"], /^skill-catalog;dur=\d+\.\d{2}, app;dur=\d+\.\d{2}$/);
    assert.equal(catalogResponse.headers()["content-encoding"], "gzip");
    assert(Number(catalogResponse.headers()["content-length"]) < (await catalogResponse.body()).length);
    await page.screenshot({ path: `${out}/recovered-${width}-${locale}.png`, fullPage: true });
    assert.equal(writes, 0);
    assert.equal(historyReads, 0, "Opening creation must not fetch input recall history");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(app.base + "/new", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(async () => {
      const api = globalThis.__pandaForceDebug,
        original = window.fetch;
      window.__catalogOriginalFetch = original;
      window.fetch = (resource, options = {}) => {
        if (
          new URL(resource, location.href).pathname === "/api/rpc" &&
          JSON.parse(options.body).method === "model/list"
        )
          return new Promise((_, reject) =>
            options.signal.addEventListener(
              "abort",
              () => reject(new DOMException("signal is aborted without reason", "AbortError")),
              { once: true },
            ),
          );
        return original(resource, options);
      };
      api.mutations.set("models", []);
      await api.loadModels({ attempts: 1, timeoutMs: 20 });
      window.fetch = window.__catalogOriginalFetch;
    });
    const messages = JSON.parse(await readFile(`src/shared/i18n/locales/${locale}/errors.json`, "utf8"));
    const notice = page.locator(".persistent-error-body p").filter({ hasText: messages.modelLoadTimedOut });
    await notice.waitFor();
    assert(
      !(await page
        .locator("#persistentErrors")
        .innerText()
        .then((text) => text.includes("signal is aborted"))),
    );
    await page.screenshot({ path: `${out}/model-timeout-${width}-${locale}.png` });
    await openComposerSettings(page, "model");
    await page.waitForFunction(() => globalThis.__pandaForceDebug.state.modelLoadStatus === "ready");
    assert.equal(
      await page.locator(".persistent-error-body p").filter({ hasText: messages.modelLoadTimedOut }).count(),
      0,
      "A recovered model catalog removes its obsolete error",
    );
    await page.keyboard.press("Escape");
    const prompt = page.locator("#prompt");
    assert.equal(historyReads, 0, "Opening a native input must not preload its history either");
    await prompt.fill("An untouched draft");
    await prompt.press("ArrowUp");
    assert.equal(await prompt.inputValue(), "An untouched draft");
    assert.equal(historyReads, 0);
    await prompt.fill("");
    await prompt.press("ArrowUp");
    await page.locator(".composer-history-status:visible").waitFor();
    await page.screenshot({ path: `${out}/history-loading-${width}-${locale}.png` });
    await prompt.press("ArrowUp");
    assert.equal(historyReads, 1, "Repeated keys join the outstanding page read");
    await prompt.fill("Typed while history is loading");
    const readFinished = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/composer/history",
    );
    releaseHistory();
    await readFinished;
    await page.waitForTimeout(100);
    assert.equal(await prompt.inputValue(), "Typed while history is loading");
    assert.equal(await page.locator(".composer-history-status").isVisible(), false);
    await prompt.fill("");
    await prompt.press("ArrowUp");
    await page.waitForFunction(() => document.querySelector("#prompt").value === "Saved input 999");
    for (let i = 0; i < 20; i++) await prompt.press("ArrowUp");
    await page.waitForFunction(() => document.querySelector("#prompt").value === "Saved input 979");
    assert.equal(historyReads, 2, "Older inputs are read as the first page is exhausted");
    await page.screenshot({ path: `${out}/history-${width}-${locale}.png` });
    assert.deepEqual(errors, []);
    records.push({
      width,
      locale,
      failureIsNotEmpty: true,
      retryPreservesDraftAndSearch: true,
      noPhantomPagination: true,
      serviceTiming: true,
      ownedModelTimeoutLocalized: true,
      nativeModelRetry: true,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
console.log(
  "Creation discovery failure/recovery, service timing and model timeout presentation passed in four locales",
);
