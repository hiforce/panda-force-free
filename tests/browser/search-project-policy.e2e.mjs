import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { openLegacySearchDatabase } from "../support/search-ledger-v2.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

const app = await createAppFixture(),
  out = ".artifacts/search-project-policy";
await mkdir(out, { recursive: true });
const projects = [];
try {
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext();
  try {
    await app.signIn(context);
    for (const width of [1440, 390]) {
      const snapshot = await (await context.request.get(app.base + "/api/projects")).json();
      const response = await context.request.post(app.base + "/api/projects", {
        data: { revision: snapshot.revision, code: "shared-policy-" + width, name: "Shared research " + width },
      });
      assert.ok(response.ok(), await response.text());
      projects.push((await response.json()).projects.find((p) => p.code === "shared-policy-" + width));
    }
  } finally {
    await context.close();
    await browser.close();
  }
  await app.stop();
  const file = join(app.dir, "panda-state", "data", "search.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) await rm(file + suffix, { force: true });
  const legacy = openLegacySearchDatabase(file);
  try {
    for (const project of projects)
      for (let i = 0; i < 8; i++) {
        const owner = "legacy-author-" + i,
          key = createHash("sha256")
            .update(JSON.stringify(["builtin", owner, project.id]))
            .digest("hex");
        legacy
          .query(
            "INSERT INTO search_scopes(key,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,'builtin',?,?,?,?,1,'disabled',?)",
          )
          .run(
            key,
            owner,
            project.id,
            JSON.stringify({ ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["secrets/" + i + ".md"] }),
            i + 1,
            Date.now() - i * 1000,
          );
      }
  } finally {
    legacy.close();
  }
  await app.start();
  for (const [index, engine, width, locale] of [
    [0, chromium, 1440, "en"],
    [1, webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width > 600 ? "light" : "dark",
      });
    try {
      await app.signIn(context);
      const api = async (path, body) => {
        const response = body
          ? await context.request.post(app.base + path, { data: body })
          : await context.request.get(app.base + path);
        assert.ok(response.ok(), await response.text());
        return response.json();
      };
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/settings/search-settings");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const host = page.locator('[data-settings-view="search-settings"]'),
        project = projects[index];
      await host.locator("[data-scope-project]").selectOption(project.id);
      await host.locator("[data-project-policy-status]").waitFor({ state: "visible" });
      assert.match(await host.locator("[data-project-policy-status]").innerText(), /need review|需要确认/);
      const before = await api("/api/search/status?" + new URLSearchParams({ project: project.id }));
      assert.equal(before.state, "needsReview");
      const query = await api("/api/search/query", { project: project.id, query: "research" });
      assert.equal(query.state, "needsReview");
      assert.equal(query.failure, null);
      await host.locator("[data-project-policy-history] > summary").click();
      await waitFor(async () => (await host.locator("[data-policy-items] > article").count()) === 4);
      await host.locator("[data-policy-items] > article details > summary").first().click();
      assert.match(
        await host.locator("[data-policy-items] > article .search-policy-rules").first().innerText(),
        /secrets\//,
      );
      await host.locator("[data-policy-next]").click();
      await host.locator("[data-policy-next]").waitFor({ state: "hidden" });
      assert.equal(await host.locator("[data-policy-items] > article").count(), 4);
      await host.locator("[data-policy-previous]").click();
      await host.locator("[data-policy-previous]").waitFor({ state: "hidden" });
      let writes = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/search/settings" && request.method() === "PUT") writes++;
      });
      await host.locator("[data-policy-choice]").first().click();
      assert.match(await host.locator('[name="pf-search-exclude"]').inputValue(), /^secrets\/\d\.md$/);
      assert.equal(writes, 0);
      assert.equal(
        (await api("/api/search/status?" + new URLSearchParams({ project: project.id }))).state,
        "needsReview",
      );
      await host.locator("[data-policy-items] > article details > summary").first().click();
      await host.locator("[data-project-policy-history]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/review-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const save = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/search/settings" && response.request().method() === "PUT",
      );
      await host.locator('[data-index-form] [type="submit"]').click();
      assert.equal((await save).ok(), true);
      const saved = await api("/api/search/status?" + new URLSearchParams({ project: project.id }));
      assert.equal(saved.projectPolicy.needsReview, false);
      assert.equal(saved.revision, before.revision + 1);
      assert.equal(writes, 1);
      await waitFor(async () =>
        /shared by all members|共用同一份/.test(await host.locator("[data-project-policy-status]").innerText()),
      );
      await host.locator("[data-project-policy-history] > summary").click();
      await host.locator("[data-policy-next]").waitFor({ state: "visible" });
      const draft = await host.locator('[name="pf-search-exclude"]').inputValue();
      let release;
      const held = new Promise((resolve) => (release = resolve)),
        previous = await api(
          "/api/search/previous-settings?" +
            new URLSearchParams({ project: project.id, source: "builtin", offset: "4" }),
        );
      await page.route(
        "**/api/search/previous-settings?*",
        async (route) => {
          await held;
          await route.fulfill({ json: previous }).catch(() => {});
        },
        { times: 1 },
      );
      const issued = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/search/previous-settings",
      );
      await host.locator("[data-policy-next]").click();
      await issued;
      await host.locator("[data-scope-project]").selectOption("personal");
      release();
      await host.locator("[data-project-policy-status]").waitFor({ state: "hidden" });
      assert.equal(await host.locator("[data-policy-items] > article").count(), 0);
      await host.locator("[data-scope-project]").selectOption(project.id);
      await waitFor(async () => (await host.locator('[name="pf-search-exclude"]').inputValue()) === draft);
      for (const size of width === 390 ? [320, 767] : [1440]) {
        await page.setViewportSize({ width: size, height: 960 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      }
      assert.deepEqual(errors, []);
      console.log(
        `${width}: exact legacy choices are paged; loading is draft-only; explicit save resolves the policy; scope switch rejects late history`,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/checked.json",
    JSON.stringify(
      {
        source: "real application restart from fixed schema-two metadata",
        pc: true,
        h5: true,
        manualAcceptance: "pending",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await app.dispose();
}
