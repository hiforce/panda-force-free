import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/navigation-performance";
await mkdir(out, { recursive: true });
const measurements = [];
const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      ...(engine === webkit ? devices["iPhone 13"] : {}),
      viewport: { width, height: 960 },
      locale,
    });
    const catalogGate = gate(),
      adminGate = gate(),
      treeGate = gate();
    try {
      await app.signIn(context);
      const api = async (path, data) => {
        const r = await context.request[data ? "post" : "get"](app.base + path, { data });
        assert.ok(r.ok(), path + ": " + r.status());
        return r.json();
      };
      const makeProject = async (code) => {
        const snapshot = await api("/api/projects");
        const created = await api("/api/projects", { name: code, code, revision: snapshot.revision });
        return created.projects.find((p) => p.code === code);
      };
      const a = await makeProject("navigation-a-" + width),
        b = await makeProject("navigation-b-" + width),
        emptyProject = await makeProject("navigation-empty-" + width);
      const create = async (project, title) => {
        const tree = await api("/api/project-document-tree?project=" + project.id);
        return (
          await api("/api/project-document-tree/documents", {
            id: crypto.randomUUID(),
            projectId: project.id,
            treeVersion: tree.version,
            title,
            locale: "en",
            parentId: null,
          })
        ).operation.documentId;
      };
      const first = await create(a, "First existing document"),
        second = await create(a, "Second existing document");
      await create(b, "A separate project document");
      const page = await context.newPage(),
        errors = [],
        heavy = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let holdCatalog = false,
        denyCatalog = false,
        holdTree = false,
        failTree = false;
      page.on("request", (request) => {
        if (/\/(?:template-settings|writing-skill|document-rich-runtime)\.bundle\.js/.test(request.url()))
          heavy.push(request.url());
      });
      await page.route("**/template-settings.bundle.js*", async (route) => {
        await adminGate.promise;
        await route.continue();
      });
      await page.route("**/api/template-catalog?*", async (route) => {
        if (holdCatalog) await catalogGate.promise;
        if (denyCatalog) return route.fulfill({ status: 403, json: { messageId: "plugins.packageUnavailable" } });
        await route.continue();
      });
      await page.route("**/api/project-document-tree?*", async (route) => {
        if (holdTree) await treeGate.promise;
        if (failTree) return route.fulfill({ status: 503, json: { messageId: "documents.unavailable" } });
        await route.continue();
      });
      const go = (path) =>
        page.evaluate((path) => {
          history.pushState({}, "", path);
          dispatchEvent(new PopStateEvent("popstate"));
        }, path);
      await page.goto(app.base + "/workspace");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
      await page.waitForLoadState("networkidle");
      const start = performance.now();
      await page
        .locator(
          width > 700
            ? '#sidebar [data-wb="route"][data-route="skills"]'
            : '.workbench-mobile-nav [data-route="skills"]',
        )
        .click();
      await page.locator(".skills-workspace h1").waitFor({ timeout: 1000 });
      const shellMs = performance.now() - start;
      await page.waitForFunction(
        () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
      );
      const contentMs = performance.now() - start;
      assert.deepEqual(heavy, [], "A skills listing must not fetch administration or editor runtimes");
      await go("/skills/writing");
      await page.locator(".template-card").first().waitFor();
      await page.waitForFunction(
        () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
      );
      const key = await page.locator(".template-card").first().getAttribute("data-template-key");
      await go("/projects");
      holdCatalog = true;
      await go("/skills/writing");
      await page.locator(`[data-template-key="${key}"]`).waitFor({ timeout: 1000 });
      assert.equal(await page.locator(".template-manager").getAttribute("aria-busy"), "true");
      await page.screenshot({ path: `${out}/cached-skills-${width}.png` });
      catalogGate.release();
      holdCatalog = false;
      await page.waitForFunction(
        () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
      );
      const requested = page.waitForRequest((request) => request.url().includes("/template-settings.bundle.js"));
      await page.locator('[data-template-action="import"]').click();
      await requested;
      const imported = page.waitForResponse(
        (response) =>
          response.url().includes("/template-settings.bundle.js") && response.request().resourceType() === "script",
      );
      await go("/projects");
      adminGate.release();
      await imported;
      assert.equal(
        await page.locator("#managedTemplateDialog").count(),
        0,
        "A stale command cannot instantiate its dialogs after navigation",
      );
      holdTree = true;
      await go("/documents?project=" + a.id);
      await page.locator(".documents-heading").waitFor({ timeout: 1000 });
      assert.equal(
        await page
          .locator("#documentEditor")
          .getByText(locale === "en" ? "Start your first document" : "创建第一篇文档", { exact: true })
          .count(),
        0,
      );
      await page.screenshot({ path: `${out}/documents-loading-${width}.png` });
      treeGate.release();
      holdTree = false;
      await page.locator("#documentReadTitle").waitFor();
      assert.equal(new URL(page.url()).searchParams.get("document"), first);
      assert.equal(await page.locator("#documentReadTitle").textContent(), "First existing document");
      assert.equal(
        heavy.some((url) => url.includes("document-rich-runtime")),
        false,
        "Reading must not compete with an editor download",
      );
      if (width < 700) await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(`[data-tree-id="${second}"] .document-tree-title`).click();
      await page.waitForFunction(
        () => document.querySelector("#documentReadTitle")?.textContent === "Second existing document",
      );
      if (width < 700) await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(`[data-tree-id="${first}"] .document-tree-handle`).click();
      await page.locator(`#documentMoveOptions input[value="${second}"]`).check();
      await page.locator('#authoringDocumentDialog [type="submit"]').click();
      await page.locator("#authoringDocumentDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#documentReadTitle").textContent(), "Second existing document");
      await go("/projects");
      await go("/documents?project=" + a.id);
      await page.waitForFunction(
        () => document.querySelector("#documentReadTitle")?.textContent === "Second existing document",
      );
      await go("/documents?project=" + b.id);
      await page.waitForFunction(
        () => document.querySelector("#documentReadTitle")?.textContent === "A separate project document",
      );
      await go("/documents?project=" + a.id + "&document=" + first);
      await page.waitForFunction(
        () => document.querySelector("#documentReadTitle")?.textContent === "First existing document",
      );
      await go("/projects");
      failTree = true;
      await go("/documents?project=" + a.id);
      await page.locator('[data-authoring-action="reload-workspace"]').waitFor();
      assert.equal(
        await page
          .locator("#documentEditor")
          .getByText(locale === "en" ? "Start your first document" : "创建第一篇文档", { exact: true })
          .count(),
        0,
      );
      failTree = false;
      await page.locator('[data-authoring-action="reload-workspace"]').click();
      await page.locator("#documentReadTitle").waitFor();
      await page.screenshot({ path: `${out}/documents-ready-${width}.png` });
      await go("/documents?project=" + a.id + "&document=missing-document");
      await page.locator('[data-authoring-action="reload-workspace"]').waitFor();
      assert.equal(
        await page.locator("#documentReadTitle").count(),
        0,
        "An explicit missing URL must not open another document",
      );
      await go("/documents?project=" + emptyProject.id);
      await page
        .locator("#documentEditor")
        .getByText(locale === "en" ? "Start your first document" : "创建第一篇文档", { exact: true })
        .waitFor();
      assert.equal(await page.locator("#documentReadTitle").count(), 0);
      denyCatalog = true;
      await go("/skills/writing");
      await page.locator('[data-template-notice][data-error="true"]').waitFor();
      assert.equal(await page.locator(".template-card").count(), 0, "Authorization failure must clear cached metadata");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      measurements.push({
        browser: engine.name(),
        width,
        shellMs: Math.round(shellMs),
        contentMs: Math.round(contentMs),
        listingHasNoHeavyRuntimes: true,
        cachedMetadataImmediatelyVisible: true,
        defaultSelectionAndProjectIsolation: true,
        falseEmptyStateRemoved: true,
        delayedAndFailedReadsRecover: true,
      });
    } finally {
      catalogGate.release();
      adminGate.release();
      treeGate.release();
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/measurements.json",
    JSON.stringify(
      {
        conditions:
          "Disposable local product data; application ready before navigation; normal unthrottled loopback; PC/H5",
        measurements,
      },
      null,
      2,
    ),
  );
  console.log(
    "PC/H5 immediate catalogs, cached metadata, lazy commands, default documents, isolation and truthful failure states passed.",
  );
} finally {
  await app.dispose();
}
