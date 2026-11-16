import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/search-configuration",
  providerRequests = [];
await mkdir(out, { recursive: true });
const provider = createServer((req, res) => {
  providerRequests.push({ url: req.url, method: req.method });
  res.setHeader("content-type", "application/json");
  if (req.url === "/v2/vectordb/collections/list") res.end(JSON.stringify({ code: 0, data: [] }));
  else if (req.url === "/v1/models/synthetic") res.end(JSON.stringify({ id: "synthetic" }));
  else res.writeHead(500).end("{}");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const endpoint = "http://127.0.0.1:" + provider.address().port;
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
      const initialProviderCount = providerRequests.length;
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const current = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "config-" + width,
          name: "Knowledge sources",
          revision: current.revision,
        }),
        project = created.projects.find((p) => p.code === "config-" + width);
      let tree = await api("/api/project-document-tree?project=" + project.id);
      const document = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: tree.version,
        title: "Architecture notes",
        locale: "en",
        parentId: null,
      });
      const documentId = document.operation.documentId;
      tree = await api("/api/project-document-tree?project=" + project.id);
      await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: tree.version,
        title: "Deployment guide",
        locale: "en",
        parentId: documentId,
      });
      const page = await context.newPage(),
        errors = [],
        settingsWrites = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/search/settings" && request.method() === "PUT")
          settingsWrites.push(request.postDataJSON());
      });
      await page.goto(app.base + "/settings/search-settings");
      const settings = page.locator('[data-settings-view="search-settings"]');
      await settings.locator("[data-source-new]").waitFor();
      await settings.locator(".search-connections > summary").click();
      const form = settings.locator("[data-connection-form]");
      await form.locator('[name="pf-search-kind"]').selectOption("milvus");
      assert.equal(await form.locator('[name="pf-search-model"]').isVisible(), false);
      await form.locator('[name="pf-search-id"]').fill("vector-" + width);
      await form.locator('[name="pf-search-url"]').fill(endpoint);
      await form.locator('[name="pf-search-authentication"]').selectOption("password");
      await form.locator('[name="pf-search-username"]').fill("root");
      await form.locator('[name="pf-search-secret"]').fill("synthetic-storage-password");
      await form.locator('[type="submit"]').click();
      await settings.locator(".search-profile-list strong", { hasText: "vector-" + width }).waitFor();
      assert.equal(await settings.locator(".search-connections").getAttribute("open"), "");
      await form.locator('[name="pf-search-kind"]').selectOption("openai");
      await form.locator('[name="pf-search-id"]').fill("embedding-" + width);
      await form.locator('[name="pf-search-url"]').fill(endpoint + "/v1");
      await form.locator('[name="pf-search-authentication"]').selectOption("apiKey");
      await form.locator('[name="pf-search-secret"]').fill("synthetic-model-secret");
      await form.locator('[name="pf-search-model"]').fill("synthetic");
      await form.locator('[name="pf-search-dimensions"]').fill("4");
      await page.screenshot({ path: out + "/connection-" + width + ".png" });
      await form.locator('[type="submit"]').click();
      await settings.locator(".search-profile-list strong", { hasText: "embedding-" + width }).waitFor();
      assert.equal(await form.locator('[name="pf-search-secret"]').inputValue(), "");
      assert.doesNotMatch(await settings.innerText(), /synthetic-model-secret|synthetic-storage-password/);
      const profile = settings.locator("[data-knowledge-profile-form]");
      await profile.locator('[name="pf-search-id"]').fill("retrieval-" + width);
      await profile.locator('[name="pf-search-vectors"]').selectOption("vector-" + width);
      await profile.locator('[name="pf-search-embeddings"]').selectOption("embedding-" + width);
      await profile.locator('[type="submit"]').click();
      await settings.locator(".search-profile-list strong", { hasText: "retrieval-" + width }).waitFor();
      await settings.locator("[data-source-new]").click();
      const source = settings.locator("[data-source-form]"),
        sourceId = "knowledge-" + width;
      await source.locator('[name="pf-search-id"]').fill(sourceId);
      await source.locator('[name="pf-search-name"]').fill("Local text + approved knowledge");
      await source.locator('[name="pf-search-knowledge"]').selectOption("retrieval-" + width);
      await source.locator('[type="submit"]').click();
      await settings.locator('[data-source-edit="' + sourceId + '"]').waitFor();
      const before = providerRequests.length;
      assert.equal(before, initialProviderCount);
      assert.equal((await api("/api/search/catalog")).binding.source, "builtin");
      assert.equal(providerRequests.length, before);
      const checked = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/search/health");
      await settings.locator('[data-source-health="' + sourceId + '"]').click();
      assert.ok((await checked).ok());
      assert.equal(providerRequests.length, before + 2);
      assert.equal(providerRequests.at(-1).method, "GET");
      assert.equal(
        providerRequests.some((r) => r.url.includes("embed")),
        false,
      );
      await settings.locator("[data-scope-source]").selectOption(sourceId);
      await settings.locator("[data-scope-project]").selectOption(project.id);
      await waitFor(async () => !(await settings.locator("[data-index-form] fieldset").isDisabled()));
      const index = settings.locator("[data-index-form]");
      assert.equal(await index.locator('[name="pf-search-vector"]').isChecked(), false);
      await settings.locator("[data-embedding-usage]").waitFor({ state: "visible" });
      assert.match(await settings.locator("[data-embedding-usage]").innerText(), /500/);
      await settings.locator("[data-embedding-usage]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/usage-" + width + ".png" });
      await index.locator('[name="pf-search-vector"]').check();
      await index.locator('[name="pf-search-fulltext"]').uncheck();
      await index.locator('[name="pf-search-knowledge-mode"]').selectOption("selected");
      await index.locator("[data-index-pick]").click();
      await index.locator('[data-knowledge-rule="subtrees"][data-document-id="' + documentId + '"]').check();
      await index.locator('[data-knowledge-rule="exclude"][data-document-id="' + documentId + '"]').check();
      await page.screenshot({ path: out + "/scope-" + width + ".png" });
      const providerBeforeSave = providerRequests.length;
      await index.locator('[type="submit"]').click();
      await waitFor(async () => settingsWrites.length === 1 && !(await settings.getAttribute("aria-busy")));
      const saved = await api("/api/search/status?" + new URLSearchParams({ project: project.id, source: sourceId }));
      assert.equal(saved.settings.enabled, false);
      assert.equal(saved.settings.fulltext, false);
      assert.equal(saved.settings.vector, true);
      assert.deepEqual(saved.settings.knowledge, {
        mode: "selected",
        documents: [],
        subtrees: [documentId],
        exclude: [documentId],
      });
      assert.equal(providerRequests.length, providerBeforeSave);
      await api(
        "/api/search/settings",
        {
          project: project.id,
          source: sourceId,
          revision: saved.revision,
          settings: {
            ...saved.settings,
            knowledge: { ...saved.settings.knowledge, exclude: [documentId, "unlisted-original"] },
          },
        },
        "put",
      );
      await page.reload();
      await settings.locator("[data-source-new]").waitFor();
      await settings.locator("[data-scope-source]").selectOption(sourceId);
      await settings.locator("[data-scope-project]").selectOption(project.id);
      await waitFor(async () => !(await index.locator("fieldset").isDisabled()));
      assert.equal(await index.locator('[name="pf-search-vector"]').isChecked(), true);
      assert.equal(await index.locator('[name="pf-search-fulltext"]').isChecked(), false);
      assert.equal(await index.locator('[name="pf-search-knowledge-mode"]').inputValue(), "selected");
      await index.locator("[data-index-pick]").click();
      await index.locator('[data-knowledge-rule="documents"][data-document-id="' + documentId + '"]').check();
      await index.locator("[data-knowledge-filter]").fill("Deployment");
      assert.equal(
        await index.locator('[data-knowledge-rule="documents"][data-document-id="' + documentId + '"]').count(),
        0,
      );
      await index.locator("[data-knowledge-filter]").fill("");
      assert.equal(
        await index.locator('[data-knowledge-rule="documents"][data-document-id="' + documentId + '"]').isChecked(),
        true,
      );
      await index.locator('[type="submit"]').click();
      await waitFor(async () => settingsWrites.length === 2 && !(await settings.getAttribute("aria-busy")));
      const restored = await api(
        "/api/search/status?" + new URLSearchParams({ project: project.id, source: sourceId }),
      );
      assert.deepEqual(restored.settings.knowledge.documents, [documentId]);
      assert.deepEqual(restored.settings.knowledge.exclude, [documentId, "unlisted-original"]);
      assert.equal(providerRequests.length, providerBeforeSave);

      assert.equal((await api("/api/search/catalog")).binding.source, "builtin");
      await settings.locator('[data-source-edit="' + sourceId + '"]').click();
      assert.equal(await source.locator('[name="pf-search-knowledge"]').inputValue(), "retrieval-" + width);
      await settings.locator("[data-source-cancel]").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log("Search connections, model metadata, retrieval profiles and opt-in scope: PASS");
} finally {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(() => resolve()));
  await app.dispose();
}
