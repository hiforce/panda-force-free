import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { officeFixture } from "../support/office-presentation.js";

const app = await createAppFixture(),
  out = ".artifacts/native-original-search/screens";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: width === 1440 ? "light" : "dark",
      });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "native-search-" + width,
          name: "Launch library",
          revision: catalog.revision,
        }),
        project = created.projects.find((p) => p.code === "native-search-" + width).id;
      async function save(scope, kind, title, bytes, previous) {
        const query = new URLSearchParams({
          project: scope,
          kind,
          title,
          locale: "en",
          name: kind === "web" ? "launch.html" : "launch.pptx",
          id: previous?.id || "c-" + randomUUID(),
          operationId: randomUUID(),
          ...(previous ? { version: previous.version } : {}),
        });
        const response = await context.request.post(app.base + "/api/creative-assets/import?" + query, {
          data: bytes,
          headers: { "content-type": "application/octet-stream" },
        });
        assert.equal(response.status(), 201, await response.text());
        return (await response.json()).asset;
      }
      const html = (text) =>
          Buffer.from("<!doctype html><main><h1>" + text + "</h1><p>Saved source evidence.</p></main>"),
        personal = await save("personal", "web", "Personal insight", html("Citron personal insight")),
        web = await save(project, "web", "Launch overview", html("Citron launch overview")),
        slides = await save(
          project,
          "slides",
          "Launch presentation",
          Buffer.from(officeFixture({ slides: 2 }).bytes()),
        );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      const snap = async (name) => {
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name);
        await page.screenshot({ path: `${out}/${name}-${width}.png` });
      };
      await page.goto(app.base + "/settings/search-settings");
      const settings = page.locator('[data-settings-view="search-settings"]');
      await settings.locator("[data-scope-project]").selectOption(project);
      await waitFor(async () => !(await settings.locator("[data-index-form] > fieldset").isDisabled()));
      const form = settings.locator("[data-index-form]");
      assert.equal(await form.locator('[name="pf-search-kind-document"]').isChecked(), true);
      assert.equal(await form.locator('[name="pf-search-kind-slides"]').isChecked(), false);
      assert.equal(await form.locator('[name="pf-search-kind-web"]').isChecked(), false);
      await form.locator('[name="pf-search-kind-web"]').check();
      await form.locator('[name="pf-search-kind-slides"]').check();
      await form.locator('[name="pf-search-enabled"]').check();
      const saved = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/search/settings" && r.request().method() === "PUT",
      );
      await form.locator('[type="submit"]').click();
      assert.ok((await saved).ok());
      const statusPath = "/api/search/status?" + new URLSearchParams({ project, source: "builtin" });
      await waitFor(async () => (await api(statusPath)).state === "ready");
      await waitFor(async () => /Index ready|索引就绪/.test(await settings.locator("[data-scope-status]").innerText()));
      const status = await api(statusPath);
      assert.deepEqual(status.settings.contentKinds, ["document", "slides", "web"]);
      assert.equal(status.documentCount, 2);
      await form.scrollIntoViewIfNeeded();
      await snap("types");
      const test = settings.locator("[data-test-form]");
      await test.locator('[name="pf-search-query"]').fill("Citron");
      await test.locator('[type="submit"]').click();
      const hit = settings.locator("[data-test-results] .content-search-hit");
      await hit.waitFor();
      assert.equal(await hit.count(), 1);
      const href = await hit.getAttribute("href");
      assert.equal(new URL(href, app.base).searchParams.get("asset"), web.id);
      assert.equal(new URL(href, app.base).searchParams.get("assetVersion"), web.version);
      await hit.click();
      const dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator("[data-asset-frame]").waitFor();
      assert.equal(await dialog.frameLocator("[data-asset-frame]").locator("h1").innerText(), "Citron launch overview");
      await snap("web-result");
      await dialog.locator("[data-doc-close]").click();
      await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
      await waitFor(async () => (await page.locator("[data-creative-grid]").getAttribute("aria-busy")) === "false");
      assert.equal(await dialog.count(), 0, "An unrelated route render reopened the reader");
      await page.reload();
      await dialog.locator("[data-asset-frame]").waitFor();
      await save(project, "web", "Updated overview", html("Newer original content"), web);
      await page.reload();
      await waitFor(async () =>
        /changed since the link|原稿在此链接生成后已有更新/.test(
          await dialog.locator("[data-asset-detail]").innerText(),
        ),
      );
      assert.equal(await dialog.locator("[data-asset-frame]").count(), 0);
      assert.equal(await dialog.locator("a[download]").count(), 0);
      assert.doesNotMatch(await dialog.innerText(), /Newer original content/);
      await snap("stale-version");
      await page.goto(
        app.base + "/project?" + new URLSearchParams({ id: project, asset: slides.id, assetVersion: slides.version }),
      );
      const slideText = dialog.locator("[data-slide-text]");
      if ((await slideText.getAttribute("open")) === null) await slideText.locator("summary").click();
      await dialog.locator(".creative-asset-sections").waitFor();
      assert.match(await dialog.locator(".creative-asset-sections").innerText(), /Hello world/);
      assert.equal(await dialog.locator(".creative-asset-sections section").count(), 2);
      await snap("slides-result");
      await page.goto(
        app.base + "/create?" + new URLSearchParams({ asset: personal.id, assetVersion: personal.version }),
      );
      const personalReader = page.locator("[data-personal-reader]");
      await personalReader.locator("[data-asset-frame]").waitFor();
      assert.equal(
        await personalReader.frameLocator("[data-asset-frame]").locator("h1").innerText(),
        "Citron personal insight",
      );
      await page.reload();
      await personalReader.locator("[data-asset-frame]").waitFor();
      await snap("personal-result");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Explicit native full-text kinds, scoped results, real HTML/PPTX readers, version fences and direct-link lifetime verified on PC/H5.",
  );
} finally {
  await app.dispose();
}
