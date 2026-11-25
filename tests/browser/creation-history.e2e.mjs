import { fillComposer } from "../support/composer-settings.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const out = process.env.PANDA_CREATION_HISTORY_PROOF || ".artifacts/creation-history-browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
    startupTimeoutMs: 60000,
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
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
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
        errors = [],
        created = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error("pageerror", e.message);
      });
      page.setDefaultTimeout(20000);
      const api = async (path, data) => {
        const r = await context.request.fetch(app.base + path, {
          method: data ? "POST" : "GET",
          headers: { ...app.headers, Origin: app.base },
          ...(data ? { data } : {}),
        });
        assert(r.ok(), await r.text());
        return r.json();
      };
      const verifyShortcuts = async () => {
        const shortcuts = page.locator(".creation-session-shortcuts > a");
        await shortcuts.last().waitFor();
        await page.waitForFunction(() => {
          const navigation = document.querySelector(".creation-session-shortcuts");
          return navigation && getComputedStyle(navigation).display === "grid";
        });
        const items = await shortcuts.evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            const label = node.querySelector("span:not(.icon-slot)");
            return {
              x,
              y,
              width,
              height,
              withIcon: !!node.querySelector("svg"),
              withLabel: !!label?.getClientRects().length,
              name: node.getAttribute("aria-label"),
              title: node.getAttribute("title"),
            };
          }),
        );
        assert.equal(items.length, 2);
        assert.equal(items[0].width, items[1].width);
        assert.equal(items[0].height, items[1].height);
        assert.equal(items[0].y, items[1].y);
        assert(items[0].x + items[0].width < items[1].x);
        assert(items.every((item) => item.withIcon && item.name && item.title === item.name));
        assert(items.every((item) => item.withLabel === width >= 768));
        if (width < 768) assert(items.every((item) => item.width === item.height && item.width >= 44));
      };
      const prefix = "/api/personal/document-creations";
      await api(prefix + "/history/clear", { id: crypto.randomUUID() });
      await page.goto(app.base + "/create");
      await page.locator("#composer").waitFor();
      await verifyShortcuts();
      await page.screenshot({ path: `${out}/shortcuts-${locale}-${width}.png` });
      const works = page.locator("[data-creation-works]");
      await works.press("Enter");
      await page.locator("[data-personal-list]").waitFor();
      await page.goBack();
      await page.locator("#composer").waitFor();
      await fillComposer(page, "Write the requirements document. " + locale);
      const submitted = page.waitForResponse((r) => r.url().endsWith(prefix) && r.request().method() === "POST");
      await page.locator("#sendButton").click();
      const response = await submitted,
        first = (await response.json()).task,
        request = response.request().postDataJSON();
      created.push(first.id);
      const question = page.locator(".creation-session-status .user-input-card");
      await question.waitFor();
      await question.locator(".user-input-option").first().click();
      await question.locator(".user-input-submit").click();
      let saved;
      await waitFor(async () => {
        saved = (await api(prefix + "/detail?" + new URLSearchParams({ id: first.id }))).task;
        return saved.state === "succeeded";
      });
      const seed = async (title) => {
        const result = await api(prefix, { ...request, id: crypto.randomUUID(), prompt: title });
        created.push(result.task.id);
        return result.task.id;
      };
      const second = await seed("Research brief"),
        third = await seed("Launch plan"),
        fourth = await seed("Category mapping");
      await page.goto(app.base + "/create");
      await page.locator("[data-creation-history]").click();
      const recent = page.locator(".creation-history-page");
      await recent.locator(`[data-activity-task="${fourth}"]`).waitFor();
      assert.equal(await page.locator("#composer").isVisible(), false);
      await recent.locator("[data-activity-search-toggle]").click();
      await recent.locator("[data-activity-search]").fill("Category mapping");
      assert.equal(await recent.locator("[data-activity-task]").count(), 1);
      await recent.locator("[data-activity-search]").fill("");
      await recent.locator("[data-activity-search]").press("Escape");
      const remove = recent.locator(`[data-history-clear="${fourth}"]`);
      assert((await remove.boundingBox()).width >= 44);
      assert((await remove.boundingBox()).height >= 44);
      await page.screenshot({ path: `${out}/records-${locale}-${width}.png` });
      await remove.focus();
      await page.keyboard.press("Enter");
      const dialog = page.locator("dialog.confirmation-dialog[open]");
      await dialog.waitFor();
      assert(
        await dialog
          .locator("button")
          .first()
          .evaluate((node) => node === document.activeElement),
      );
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert((await dialog.boundingBox()).width <= width);
      await page.screenshot({ path: `${out}/confirm-${locale}-${width}.png` });
      await dialog.locator("button").first().click();
      assert.equal(await recent.locator(`[data-activity-task="${fourth}"]`).count(), 1);
      await page.route("**/document-creations/history/clear", (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Access changed" }),
        }),
      );
      await remove.click();
      await dialog.waitFor();
      await dialog.locator("button").last().click();
      await waitFor(
        async () =>
          (await recent.locator('[data-history-busy="false"] [data-activity-status][data-error="true"]').count()) === 1,
      );
      assert.equal(await recent.locator('[data-history-pending="true"]').count(), 0);
      assert.equal(await recent.locator(`[data-activity-task="${fourth}"]`).count(), 1);
      await page.unroute("**/document-creations/history/clear");
      let phase = "one";
      await page.route("**/document-creations/history/clear", async (route) => {
        const body = route.request().postDataJSON();
        if (
          (phase === "one" && body.taskId === fourth) ||
          (phase === "all" && !body.taskId && route.request().url().includes("/personal/"))
        ) {
          if (phase === "all") {
            phase = "";
            await route.abort("failed");
            return;
          }
          phase = "";
          const accepted = await route.fetch();
          assert.equal(accepted.status(), 200);
          await route.abort("failed");
        } else await route.continue();
      });
      await remove.click();
      await dialog.waitFor();
      await dialog.locator("button").last().click();
      await waitFor(
        async () => (await recent.locator('[data-history-pending="true"][data-history-busy="false"]').count()) === 1,
      );
      const fifth = await seed("Created after the interrupted clear");
      await page.reload();
      await recent.locator(`[data-activity-task="${fifth}"]`).waitFor();
      await recent.locator("[data-history-clear-all]").click();
      await waitFor(async () => (await recent.locator('[data-history-pending="false"]').count()) === 1);
      assert.equal(await recent.locator(`[data-activity-task="${fifth}"]`).count(), 1);
      assert.equal(await recent.locator(`[data-activity-task="${fourth}"]`).count(), 0);
      await page.locator('.creation-home-heading a[href="/create"]').click();
      await fillComposer(page, "Keep this unsent creation draft.");
      await page.locator("[data-creation-history]").click();
      phase = "all";
      await recent.locator("[data-history-clear-all]").click();
      await dialog.waitFor();
      await dialog.locator("button").last().click();
      await waitFor(
        async () => (await recent.locator('[data-history-pending="true"][data-history-busy="false"]').count()) === 1,
      );
      const latest = await seed("New work after clearing all history");
      await page.reload();
      await recent.locator(`[data-activity-task="${latest}"]`).waitFor();
      await page.locator('.creation-home-heading a[href="/create"]').click();
      await page.locator("#prompt").waitFor();
      assert.match(await page.locator("#prompt").inputValue(), /Keep this unsent/);
      await page.locator("[data-creation-history]").click();
      await recent.locator(`[data-activity-task="${latest}"]`).waitFor();
      await recent.locator("[data-history-clear-all]").click();
      await waitFor(async () => (await recent.locator('[data-history-pending="false"]').count()) === 1);
      assert.deepEqual(
        (await api(prefix + "?project=*")).tasks.map((t) => t.id),
        [latest],
      );
      const scope = new URLSearchParams({ project: "personal", id: saved.artifact.documentId });
      assert.equal(
        (await api("/api/personal/project-documents/editor?" + scope)).saved.document.id,
        saved.artifact.documentId,
      );
      await recent.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/cleared-${locale}-${width}.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      for (const id of [second, third, fourth, fifth]) await api(prefix + "/cancel", { id });
      await page.goto(app.base + "/creation/" + latest + "?creationScope=personal");
      await page.locator(".creation-session-status .user-input-card").waitFor();
      await verifyShortcuts();
      await fillComposer(page, "Retain the draft while clearing sidebar history.");
      if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      const inspector = page.locator("#sessionInspector");
      await inspector.locator(`[data-history-clear="${latest}"]`).waitFor();
      await inspector.locator(`[data-history-clear="${latest}"]`).scrollIntoViewIfNeeded();
      const { removeBox, shellBox } = await inspector.locator(`[data-history-clear="${latest}"]`).evaluate((button) => {
        const box = (element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return { removeBox: box(button), shellBox: box(button.closest(".creation-record-shell")) };
      });
      assert(
        removeBox.width >= 44 &&
          removeBox.height >= 44 &&
          removeBox.x >= shellBox.x &&
          removeBox.y >= shellBox.y &&
          removeBox.x + removeBox.width <= shellBox.x + shellBox.width + 1 &&
          removeBox.y + removeBox.height <= shellBox.y + shellBox.height + 1,
        `Sidebar delete target must remain inside its own record: ${JSON.stringify({ removeBox, shellBox })}`,
      );
      await page.screenshot({ path: `${out}/sidebar-${locale}-${width}.png` });
      await inspector.locator(`[data-history-clear="${latest}"]`).click();
      await dialog.waitFor();
      await dialog.locator("button").last().click();
      await waitFor(async () => (await inspector.locator(`[data-activity-task="${latest}"]`).count()) === 0);
      await inspector.locator('[data-session-action="close"]').click();
      assert.match(await page.locator("#prompt").inputValue(), /Retain the draft/);
      assert.equal((await api(prefix + "/detail?" + new URLSearchParams({ id: latest }))).task.cancelRequested, false);
      assert(await page.locator(".creation-session-status .user-input-card").isVisible());
      await api(prefix + "/cancel", { id: latest });
      results.push({
        locale,
        width,
        documentRetained: true,
        clearOneAndAll: true,
        reloadAndLostAcknowledgement: true,
        laterWorkVisible: true,
        keyboardFocus: true,
        sidebarClearingKeepsActiveTask: true,
        errors,
      });
    } catch (error) {
      const context = browser.contexts()[0],
        page = context?.pages()[0];
      if (page) {
        await page.screenshot({ path: `${out}/failure-${locale}-${width}.png` });
        console.error(
          JSON.stringify({
            locale,
            width,
            url: page.url(),
            records: await page.locator("[data-activity-task]").evaluateAll((nodes) =>
              nodes.map((node) => ({
                id: node.dataset.activityTask,
                rect: { w: node.getBoundingClientRect().width, h: node.getBoundingClientRect().height },
                visible: getComputedStyle(node).visibility,
              })),
            ),
            status: await page
              .locator(".creation-history-page, .creation-session-records")
              .first()
              .textContent()
              .catch(() => null),
          }),
        );
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
