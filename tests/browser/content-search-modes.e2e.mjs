import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

const fixture = await createAppFixture(),
  out = ".artifacts/content-search-modes";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await fixture.signIn(context);
      const page = await context.newPage(),
        queries = [],
        tests = [],
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let statusReads = 0,
        hold = false,
        entered,
        release;
      const blocked = new Promise((resolve) => {
          release = resolve;
        }),
        observed = new Promise((resolve) => {
          entered = resolve;
        });
      const hit = {
        kind: "knowledge",
        id: "approved-one",
        title: "Reviewed storage guidance",
        snippet: "Approved evidence and current source versions.",
        score: 1,
        version: "a".repeat(64),
        project: "personal",
        url: "/documents?project=personal&knowledge=approved-one",
        approvedAt: 1000,
        uncertaintyCount: 0,
        sources: [
          {
            id: "source-one",
            version: "saved-one",
            title: "Storage notes",
            url: "/documents?project=personal&id=source-one",
          },
        ],
      };
      await page.route("**/api/search/query", async (route) => {
        const body = route.request().postDataJSON();
        queries.push(body);
        assert.ok(["text", "semantic", "hybrid"].includes(body.mode));
        const queued = queries.length === 1 || queries.length === 4;
        await route.fulfill({
          json: {
            hits: queued ? [] : [hit],
            nextCursor: queries.length === 2 ? "page-two" : null,
            state: queued ? "running" : "ready",
            failure: null,
          },
        });
      });
      await page.route("**/api/search/status?*", async (route) => {
        statusReads++;
        if (hold) {
          entered();
          await blocked;
        }
        const ready = statusReads >= 3;
        await route
          .fulfill({
            json: {
              settings: { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
              revision: 1,
              state: ready ? "ready" : "running",
              documentCount: 1,
              ready,
              source: "builtin",
              failure: null,
            },
          })
          .catch((error) => {
            if (!hold) throw error;
          });
      });
      await page.route("**/api/search/test", async (route) => {
        tests.push(route.request().postDataJSON());
        await route.fulfill({ json: { hits: [hit], nextCursor: null, state: "ready", failure: null } });
      });
      await page.goto(fixture.base + "/");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-wb="route"][data-route="projects"]:visible').first().waitFor();
      await page.keyboard.press("ControlOrMeta+k");
      try {
        await page.locator("[data-search-tab=content]").click();
      } catch (error) {
        await page.screenshot({ path: out + "/open-failure-" + width + ".png" });
        console.error(JSON.stringify({ width, url: page.url(), errors }));
        throw error;
      }
      const pane = page.locator("[data-search-content]"),
        mode = pane.locator("[data-search-mode]"),
        input = pane.locator("[data-content-query]"),
        submit = pane.locator("[type=submit]");
      assert.equal(await mode.inputValue(), "text");
      await mode.selectOption("semantic");
      await input.fill("saved storage");
      await page.waitForTimeout(350);
      assert.equal(queries.length, 0, "Semantic typing and mode changes must not issue a query");
      await submit.click();
      await page.waitForFunction(() =>
        /Press Search to run|点击搜索以执行/.test(document.querySelector("[data-search-status]").textContent),
      );
      assert.equal(queries.length, 1, "Index readiness polls must use metadata, never repeat the semantic query");
      assert.ok(statusReads >= 3);
      await mode.selectOption("hybrid");
      await input.fill("storage facts");
      await page.waitForTimeout(350);
      assert.equal(queries.length, 1);
      await submit.click();
      await pane.locator(".content-search-hit").waitFor();
      assert.match(await pane.locator(".content-search-hit").getAttribute("href"), /knowledge=approved-one/);
      assert.equal(await pane.locator("[data-search-mode-hint]").isVisible(), true);
      assert.equal(
        await pane.evaluate((node) => {
          const dialog = node.closest("dialog");
          return getComputedStyle(dialog).overflowY === "hidden" && dialog.scrollHeight <= dialog.clientHeight + 1;
        }),
        true,
        "The search frame must not create a second scrollbar",
      );
      await page.screenshot({ path: `${out}/query-${theme}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await pane.locator("[data-search-more]").click();
      await pane.locator(".content-search-hit").nth(1).waitFor();
      assert.equal(queries.length, 3);
      assert.equal(queries[2].cursor, "page-two");
      assert.equal(queries[2].mode, "hybrid");
      await mode.selectOption("semantic");
      await input.fill("another explicit query");
      hold = true;
      await submit.click();
      await observed;
      await page.keyboard.press("Escape");
      release();
      await page.waitForTimeout(350);
      assert.equal(queries.length, 4, "Closing a pending metadata poll must never restart a search");
      assert.equal(await pane.isVisible(), false);
      hold = false;
      await page.goto(fixture.base + "/settings/search-settings");
      const settings = page.locator('[data-settings-view="search-settings"]'),
        form = settings.locator("[data-test-form]");
      await settings.locator("[data-index-form] fieldset").waitFor({ state: "visible" });
      await form.locator("[data-search-mode]").selectOption("hybrid");
      await form.locator("[name=pf-search-query]").fill("reviewed storage");
      await page.waitForTimeout(350);
      assert.equal(tests.length, 0);
      await form.locator("[type=submit]").click();
      await settings.locator("[data-test-results] .content-search-hit").waitFor();
      assert.equal(tests.length, 1);
      assert.equal(tests[0].mode, "hybrid");
      assert.equal(tests[0].source, "builtin");
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/settings-${theme}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Explicit semantic/hybrid submissions, metadata-only readiness polling, current-mode pagination and cancellation verified on PC/H5.",
  );
} finally {
  await fixture.dispose();
}
