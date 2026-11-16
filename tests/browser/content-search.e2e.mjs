import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  out = ".artifacts/content-search";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale, acceptDownloads: true });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const r = await context.request[method](app.base + path, { data });
        assert.ok(r.ok(), path + ": " + (await r.text()));
        return r.json();
      };
      const snapshot = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "search-" + width,
          name: "Search notes",
          revision: snapshot.revision,
        }),
        project = created.projects.find((p) => p.code === "search-" + width);
      const tree = await api("/api/project-document-tree?project=" + project.id),
        doc = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title: "Document indexing handbook",
          locale: "en",
          parentId: null,
        });
      const id = doc.operation.documentId,
        q = new URLSearchParams({ project: project.id, id }),
        opened = await api("/api/project-documents/editor?" + q),
        draft = await api(
          "/api/project-documents/editor?" + q,
          {
            operationId: crypto.randomUUID(),
            version: opened.draft.version,
            baseRevisionId: opened.draft.baseRevisionId,
            working: {
              ...opened.working,
              body: {
                schema: 1,
                format: "richtext",
                document: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Running index workers keep the document catalog searchable." }],
                    },
                  ],
                },
              },
            },
          },
          "put",
        );
      await api("/api/project-documents/checkpoints?" + q, {
        operationId: crypto.randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.receipt.version,
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/settings/search-settings");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const settings = page.locator('[data-settings-view="search-settings"]');
      await settings.locator("[data-source-new]").waitFor();
      assert.equal(await settings.locator("[data-source-form]").isVisible(), false);
      await settings.locator("[data-source-new]").click();
      const form = settings.locator("[data-source-form]"),
        source = "sandbox-" + width;
      await form.locator("[name=pf-search-id]").fill(source);
      await form.locator("[name=pf-search-name]").fill("Sandbox index");
      await form.locator("[type=submit]").click();
      await settings.locator('[data-source-edit="' + source + '"]').waitFor();
      assert.equal((await api("/api/search/catalog")).binding.source, "builtin");
      await page.screenshot({ path: out + "/sources-" + width + ".png" });
      await settings.locator("[data-scope-source]").selectOption(source);
      await settings.locator("[data-scope-project]").selectOption(project.id);
      await waitFor(async () => !(await settings.locator("[data-index-form] fieldset").isDisabled()));
      let pendingStatuses = 3;
      await page.route("**/api/search/status?*", async (route) => {
        const response = await route.fetch(),
          state = await response.json(),
          url = new URL(route.request().url());
        if (
          url.searchParams.get("project") === project.id &&
          url.searchParams.get("source") === source &&
          state.settings.enabled &&
          pendingStatuses > 0
        ) {
          pendingStatuses--;
          await route.fulfill({ response, json: { ...state, state: "running", documentCount: 0 } });
        } else await route.fulfill({ response });
      });
      await settings.locator("[data-index-form] [name=pf-search-enabled]").check();
      await settings.locator("[data-index-form] [type=submit]").click();
      await waitFor(
        async () =>
          (await api("/api/search/status?" + new URLSearchParams({ project: project.id, source }))).state === "ready",
      );
      const test = settings.locator("[data-test-form]");
      await test.locator("[name=pf-search-query]").fill("runs");
      await test.locator("[type=submit]").click();
      await settings.locator("[data-test-results] .content-search-hit").waitFor();
      assert.match(await settings.locator("[data-test-results]").innerText(), /Document indexing handbook/);
      const auditResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/search/audit",
      );
      await settings.locator("[data-index-audit]").click();
      assert.equal((await auditResponse).ok(), true);
      await waitFor(async () =>
        /passed its integrity check|完整性检查通过/.test(
          await settings.locator("[data-index-audit-report]").innerText(),
        ),
      );
      const audited = await api("/api/search/status?" + new URLSearchParams({ project: project.id, source }));
      assert.equal(audited.audit.current, true);
      assert.equal(audited.audit.latest.status, "healthy");
      assert.ok(audited.audit.latest.checks.includes("text.bytes"));
      await settings.locator(".search-integrity").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/audit-" + width + ".png" });
      assert.equal(await settings.locator(".search-audit-facts > div").count(), 3);
      await settings.locator("[data-index-form] details > summary").click();
      await settings.locator("[data-index-form] [name=pf-search-include]").fill("*.md");
      await waitFor(async () => /Index ready|索引就绪/.test(await settings.locator("[data-scope-status]").innerText()));
      assert.equal(await settings.locator("[data-index-form] [name=pf-search-include]").inputValue(), "*.md");
      assert.match(await settings.locator("[data-test-results]").innerText(), /Document indexing handbook/);
      assert.equal((await api("/api/search/catalog")).binding.source, "builtin");
      await settings.locator("[data-index-preview]").click();
      await settings.locator("[data-index-preview-results] .search-scope-preview li").waitFor();
      assert.match(
        await settings.locator("[data-index-preview-results] .search-scope-preview").innerText(),
        /Document indexing handbook/,
      );
      await settings.locator("[data-index-form]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/index-" + width + ".png" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const english = (await api("/api/search/catalog")).analyzers[0].descriptor,
        pack = { ...english, id: "test.literal." + width, name: "English literal", stemming: "none" };
      await settings.locator("[data-analyzer-file]").setInputFiles({
        name: "literal.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(pack)),
      });
      await settings.locator("[data-analyzer-install]").waitFor();
      await settings.locator("[data-analyzer-install]").click();
      const reference = pack.id + "@" + pack.version;
      await settings.locator('[data-analyzer-export="' + reference + '"]').waitFor();
      const downloaded = page.waitForEvent("download");
      await settings.locator('[data-analyzer-export="' + reference + '"]').click();
      const download = await downloaded;
      assert.equal(JSON.parse(await readFile(await download.path(), "utf8")).id, pack.id);
      let releaseAudit;
      const heldAudit = new Promise((resolve) => {
        releaseAudit = resolve;
      });
      await page.route(
        "**/api/search/audit",
        async (route) => {
          await heldAudit;
          await route.fulfill({ json: audited.audit });
        },
        { times: 1 },
      );
      const auditIssued = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/search/audit");
      await settings.locator("[data-index-audit]").click();
      await auditIssued;
      await settings.locator("[data-scope-project]").selectOption("personal");
      releaseAudit();
      await waitFor(async () => !(await settings.getAttribute("aria-busy")));
      await waitFor(async () =>
        /Enable indexing|启用索引/.test(await settings.locator("[data-index-audit-report]").innerText()),
      );
      assert.equal(await settings.locator(".search-audit-facts").count(), 0);
      await settings.locator("[data-scope-project]").selectOption(project.id);
      await waitFor(async () => !(await settings.locator("[data-index-audit]").isDisabled()));
      const oldResult = await api("/api/search/test", { project: project.id, source, query: "runs" });
      let releaseResult;
      const heldResult = new Promise((resolve) => {
        releaseResult = resolve;
      });
      await page.route("**/api/search/test", async (route) => {
        await heldResult;
        await route.fulfill({ json: oldResult });
      });
      await test.locator("[name=pf-search-query]").fill("runs");
      const issued = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/search/test");
      await test.locator("[type=submit]").click();
      await issued;
      await settings.locator("[data-scope-project]").selectOption("personal");
      releaseResult();
      await waitFor(async () => !(await settings.getAttribute("aria-busy")));
      assert.equal(await settings.locator("[data-test-results] .content-search-hit").count(), 0);
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator("[data-search-tab=content]").click();
      await page.locator("[data-search-project]").selectOption(project.id);
      await page.locator("[data-content-query]").fill("running");
      await page.locator("[data-search-content] [type=submit]").click();
      await page.locator("[data-search-content] .content-search-hit").waitFor();
      assert.equal(await page.locator("[data-search-more]").isVisible(), false);
      await page.screenshot({ path: out + "/query-" + width + ".png" });
      assert.equal((await api("/api/search/catalog")).binding.source, "builtin");
      assert.equal(await page.locator("[data-search-content] [data-scope-source]").count(), 0);
      await page.locator("[data-search-content] .content-search-hit").click();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await waitFor(async () => new URL(page.url()).searchParams.get("document") === id);
      assert.deepEqual(errors, []);
      console.log(
        engine.name() +
          " " +
          width +
          ": source isolation, saved content indexing, stemming, test search, scope preview, pack review/export, user search and navigation verified",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
