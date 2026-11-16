import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/search-progress";
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
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "progress-" + width,
          name: "Index progress",
          revision: catalog.revision,
        }),
        project = created.projects.find((p) => p.code === "progress-" + width),
        settings = {
          enabled: true,
          fulltext: true,
          vector: false,
          analyzer: "panda.english@1.0.0",
          include: [],
          exclude: [],
          knowledge: { mode: "manual", documents: [], subtrees: [], exclude: [] },
        };
      await api("/api/search/settings", { project: project.id, source: "builtin", settings, revision: 0 }, "put");
      const statusPath = "/api/search/status?" + new URLSearchParams({ project: project.id, source: "builtin" });
      await waitFor(async () => (await api(statusPath)).state === "ready");
      const original = await api(statusPath);
      assert.equal(original.progress.phase, "ready");
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        app.base +
          "/settings/search-settings?" +
          new URLSearchParams({ indexProject: project.id, indexSource: "builtin" }),
      );
      const view = page.locator('[data-settings-view="search-settings"]'),
        progress = view.locator("[data-index-progress]");
      await waitFor(async () => !(await view.locator("[data-index-rebuild]").isDisabled()));
      assert.equal(await view.locator("[data-scope-project]").inputValue(), project.id);
      const rebuilt = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/search/rebuild");
      await view.locator("[data-index-rebuild]").click();
      assert.ok((await rebuilt).ok());
      await waitFor(async () => (await api(statusPath)).state === "ready");
      const completed = await api(statusPath);
      assert.notEqual(completed.progress.job, original.progress.job);
      assert.equal(completed.progress.phase, "ready");
      assert.ok(completed.progress.finishedAt >= completed.progress.startedAt);

      // Provider and durable-job behavior is verified separately; these explicit staged responses exercise rendering and reload.
      let phase = "text",
        vectorOnlyReady = false;
      await page.route("**/api/search/status?**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("project") !== project.id) return route.continue();
        await route.fulfill({
          json: {
            ...completed,
            state: vectorOnlyReady ? "ready" : "running",
            ready: vectorOnlyReady,
            documentCount: vectorOnlyReady ? 0 : completed.documentCount,
            settings: vectorOnlyReady ? { ...completed.settings, fulltext: false, vector: true } : completed.settings,
            progress: {
              ...completed.progress,
              phase: vectorOnlyReady ? "ready" : phase,
              completed: vectorOnlyReady ? 0 : 12,
              total: vectorOnlyReady || phase === "reading" ? null : 80,
              finishedAt: vectorOnlyReady ? completed.progress.finishedAt : null,
            },
          },
        });
      });
      await page.reload();
      await progress.locator('progress[value="12"][max="80"]').waitFor();
      assert.equal(await view.locator("[data-index-rebuild]").isDisabled(), true);
      assert.match(await progress.innerText(), /12.*80/);
      assert.equal(await view.locator("[data-scope-project]").inputValue(), project.id);
      await progress.scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/text-" + width + ".png" });
      phase = "reading";
      await waitFor(async () => !(await progress.locator("progress").getAttribute("value")));
      await page.screenshot({ path: out + "/reading-" + width + ".png" });
      await page.setViewportSize({ width: width === 390 ? 320 : 767, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      vectorOnlyReady = true;
      await page.setViewportSize({ width, height: 960 });
      await page.reload();
      const status = view.locator("[data-scope-status]");
      await waitFor(async () => /ready|就绪/i.test(await status.innerText()));
      assert.doesNotMatch(
        await status.innerText(),
        /\b0\b/,
        "Disabled full-text counts must not portray vector-only knowledge as an empty index",
      );
      await status.scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/vector-only-" + width + ".png" });
      await view.locator("[data-scope-project]").selectOption("personal");
      await waitFor(async () => (await progress.innerText()).trim() === "");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
