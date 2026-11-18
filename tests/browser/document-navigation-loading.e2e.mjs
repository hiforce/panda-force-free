import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/document-navigation-loading";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 90000 }),
  records = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
try {
  for (const [engine, width, locale, driver, originalOpen] of [
    [chromium, 1440, "en", "legacy", true],
    [chromium, 1440, "zh-CN", "files", false],
    [webkit, 390, "zh-HK", "legacy", true],
    [webkit, 320, "zh-TW", "files", false],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      const auth = await (await context.request.get(app.base + "/api/auth/status")).json();
      const identity =
        auth.authMode +
        ":" +
        (auth.identity?.id || auth.identity?.username || "local") +
        (auth.directoryScope ? ":" + auth.directoryScope : "");
      await context.addInitScript(
        ({ locale, identity, originalOpen }) => {
          if (window === top && /^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-browser-identity", identity);
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", "aurora");
            localStorage.setItem("panda-force-sidebar-open", String(originalOpen));
          }
        },
        { locale, identity, originalOpen },
      );
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { headers: { Origin: app.base }, data });
        assert(r.ok(), await r.text());
        return r.json();
      };
      const catalog = await api("/api/projects"),
        input = {
          name: "Loading focus " + locale,
          code: "loading-" + locale.toLowerCase(),
          revision: catalog.revision,
        };
      const result = driver === "legacy" ? app.legacyProject(input) : await api("/api/projects", input),
        project = result.projects.find((p) => p.code === input.code);
      const tree = await api("/api/project-document-tree?project=" + project.id),
        created = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title: "Loading focus",
          locale,
        });
      const id = created.operation.documentId,
        page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(25000);
      page.on("pageerror", (e) => errors.push(e.message));
      const capabilitySeen = deferred(),
        capabilityRelease = deferred(),
        detailSeen = deferred(),
        detailRelease = deferred(),
        detailFinished = deferred();
      let capabilityReads = 0,
        detailReads = 0;
      await page.route("**/api/project-documents/capabilities?*", async (route) => {
        capabilityReads++;
        capabilitySeen.resolve();
        await capabilityRelease.promise;
        if (locale === "en" && capabilityReads === 1)
          await route.fulfill({ status: 503, json: { messageId: "documents.unavailable" } });
        else await route.continue();
      });
      await page.route(/\/api\/(?:documents\/detail|project-documents\/editor)\?/, async (route) => {
        if (
          route.request().method() !== "GET" ||
          new URL(route.request().url()).searchParams.get("id") !== id ||
          ++detailReads !== 1
        )
          return route.continue();
        const response = await route.fetch();
        detailSeen.resolve();
        await detailRelease.promise;
        try {
          await route.fulfill({ response });
        } finally {
          detailFinished.resolve();
        }
      });
      const target = app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id });
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await capabilitySeen.promise;
      await page.locator("#startupScreen").waitFor({ state: "hidden" });
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const focused = async () => {
        assert.equal(await page.evaluate(() => document.body.classList.contains("document-navigation-focus")), true);
        assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "false");
        assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-sidebar-open")), String(originalOpen));
      };
      await focused();
      assert.equal(await page.locator(".document-rich-content").count(), 0);
      await page.screenshot({ path: `${out}/capability-${locale}-${width}.png` });
      capabilityRelease.resolve();
      if (locale === "en") {
        await page.locator('[data-authoring-action="reload-workspace"]').waitFor();
        await focused();
        await page.locator('[data-authoring-action="reload-workspace"]').click();
      }
      await detailSeen.promise;
      await focused();
      assert.equal(await page.locator(".document-rich-content").count(), 0);
      await page.screenshot({ path: `${out}/detail-${locale}-${width}.png` });
      await page.locator("#workspaceNavigationToggle").click();
      assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "true");
      await page.locator('.workbench-navigation [data-route="projects"]').click();
      await page.waitForURL((url) => url.pathname === "/projects");
      const restored = async () => {
        assert.equal(await page.evaluate(() => document.body.classList.contains("document-navigation-focus")), false);
        assert.equal(
          await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"),
          width >= 768 && originalOpen ? "true" : "false",
        );
        assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-sidebar-open")), String(originalOpen));
      };
      await restored();
      detailRelease.resolve();
      await detailFinished.promise;
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await restored();
      await page.goBack();
      await page.waitForFunction(() => document.body.classList.contains("document-navigation-focus"));
      await page.locator(".document-rich-content").waitFor();
      await focused();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        driver,
        originalOpen,
        collapsedBeforeCapabilities: true,
        collapsedBeforeDocument: true,
        retryWhileFocused: locale === "en",
        lateResponseDidNotRefocus: true,
        backRestoredDocument: true,
      });
      console.log("Verified loading focus", width, locale, driver, originalOpen);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/verification.json", JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.dispose();
}
