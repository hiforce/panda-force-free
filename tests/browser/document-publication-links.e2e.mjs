import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

const fixture = await createSiteBuildFixture(),
  checks = [],
  out = ".artifacts/document-publication-ui";
await mkdir(out, { recursive: true });
try {
  for (const [browserType, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await browserType.launch({
      headless: true,
      ...(browserType === chromium ? { args: ["--no-sandbox"] } : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width === 390 ? "dark" : "light",
      });
      await fixture.app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const response = await context.request[method](fixture.app.base + path, { data });
        assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get"),
        created = await api("/api/projects", {
          code: "links-" + width,
          name: "Project originals",
          revision: catalog.revision,
        }),
        project = created.projects.find((value) => value.code === "links-" + width);
      const source = await api("/api/project-documents", {
        projectId: project.id,
        title: "One original",
        locale: "en",
        folder: "Guides",
      });
      const saved = await api(
        "/api/documents/detail?id=" + source.document.id,
        {
          revision: 1,
          title: "One original",
          locale: "en",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First saved body", marks: [{ type: "underline" }] }],
                },
              ],
            },
          },
        },
        "put",
      );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.app.base + "/documents?project=" + project.id + "&document=" + source.document.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content").waitFor();
      await page.locator('[data-doc-action="publishing"]').click();
      const root = page.locator("#documentPublicationDialog"),
        form = page.locator("#documentPlacementDialog");
      await root.locator(".document-publication-empty").waitFor();
      assert.equal(await root.locator('[data-placement-action="add"]').isDisabled(), true);
      let editionFailed = false;
      await page.route(
        (url) => url.pathname === "/api/document-spaces/source-profile",
        async (route) => {
          if (!editionFailed && new URL(route.request().url()).searchParams.get("id") !== source.document.spaceId) {
            editionFailed = true;
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ messageId: "documents.unavailable", error: "Unavailable" }),
            });
            return;
          }
          await route.continue();
        },
      );
      await root.locator('[data-placement-action="new-space"]').click();
      assert.equal(await form.locator("#doc-engine").inputValue(), "hexo");
      assert.equal(await form.locator("#doc-locale").inputValue(), "en");
      await form.locator("#doc-name").fill("My blog");
      await form.locator("#doc-code").fill("my-blog");
      await form.locator('[type="submit"]').click();
      await form.locator("#doc-link-space").waitFor();
      await form.locator("#placementReloadEdition").waitFor({ state: "visible" });
      assert.equal(await form.locator('[type="submit"]').isDisabled(), true);
      await form.locator("#placementReloadEdition").click();
      await form.locator("#doc-path").fill("posts/my-article.md");
      await form.locator(".placement-metadata summary").click();
      await form.locator("#doc-title").fill("Blog edition title");
      await form.locator("#doc-tags").fill("release, guide");
      await page.waitForFunction(() => !document.querySelector('#documentPlacementDialog [type="submit"]')?.disabled);
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      await root.locator(".document-publication-card").waitFor();
      let links = (await api("/api/document-placements?document=" + source.document.id, undefined, "get")).placements;
      assert.equal(links.length, 1);
      assert.equal(links[0].path, "posts/my-article.md");
      assert.equal(links[0].metadata.title, "Blog edition title");
      assert.deepEqual(links[0].metadata.tags, ["release", "guide"]);
      assert.deepEqual(
        (await api("/api/documents/detail?id=" + source.document.id, undefined, "get")).revision.body,
        saved.revision.body,
      );
      const website = await api("/api/document-spaces", {
        projectId: project.id,
        code: "handbook",
        name: "Handbook",
        engine: "docusaurus",
        sourceMode: "managed",
        locale: "en",
        theme: "default",
      });
      await root.locator('[data-placement-action="refresh"]').click();
      await root.locator('[data-placement-action="add"]').click();
      await form.locator("#doc-link-space").selectOption(website.space.id);
      await form.locator("#doc-path").fill("guide/original.md");
      await form.locator("#doc-link-revision").selectOption(saved.revision.id);
      await form.locator("#doc-locale").fill("en-US");
      await page.waitForFunction(() => !document.querySelector('#documentPlacementDialog [type="submit"]')?.disabled);
      const requests = [];
      let dropped = false;
      await page.route(
        (url) => url.pathname === "/api/document-placements",
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          requests.push(route.request().postDataJSON());
          if (!dropped) {
            dropped = true;
            const response = await route.fetch();
            assert.equal(response.status(), 201);
            await route.abort("failed");
            return;
          }
          await route.continue();
        },
      );
      await form.locator('[type="submit"]').click();
      await form.locator(".document-form-error").waitFor({ state: "visible" });
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      await page.unrouteAll({ behavior: "wait" });
      assert.equal(requests.length, 2);
      assert.equal(requests[0].id, requests[1].id);
      links = (await api("/api/document-placements?document=" + source.document.id, undefined, "get")).placements;
      const pinned = links.find((value) => value.spaceId === website.space.id);
      assert.equal(links.length, 2);
      assert.equal(pinned.revisionId, saved.revision.id);
      assert.equal((await api("/api/document-placements/history?id=" + pinned.id, undefined, "get")).events.length, 1);
      await root.locator('[data-placement-action="close"]').click();
      await page.locator('[data-doc-action="edit"]:visible, [data-authoring-action="reader-edit"]:visible').click();
      await page.locator('.document-rich-content[contenteditable="true"]').fill("A later original body");
      await page.waitForFunction(() =>
        document.querySelector("#documentSaveState")?.textContent?.match(/All changes saved|所有修改已保存/),
      );
      await page.locator(".document-editor-more summary").click();
      await page.locator('[data-doc-action="properties"]').click();
      await page.locator("#authoringDocumentDialog #doc-locale").fill("en-GB");
      await page.locator('#authoringDocumentDialog [type="submit"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector("#documentLanguage")?.textContent === "en-GB" &&
          document.querySelector("#documentSaveState")?.textContent?.match(/All changes saved|所有修改已保存/),
      );
      await page.locator('[data-doc-action="publishing"]').click();
      await root.locator(`[data-placement-id="${pinned.id}"]`).waitFor();
      await root.locator(`[data-placement-id="${pinned.id}"] [data-placement-action="build"]`).click();
      const build = page.locator("#siteBuildDialog");
      await build.locator("#createSiteBuild").waitFor();
      assert.equal(await build.locator("#build-locale").inputValue(), "en-US");
      assert.equal(await build.locator("#build-engine").inputValue(), "docusaurus");
      await page.waitForFunction(() => !document.querySelector("#createSiteBuild")?.disabled);
      await build.locator("#createSiteBuild").click();
      await waitFor(() =>
        [...fixture.inputs.values()].some((value) =>
          value.documents.some((document) => document.id === source.document.id),
        ),
      );
      const input = [...fixture.inputs.values()].find((value) =>
        value.documents.some((document) => document.id === source.document.id),
      );
      assert.equal(input.documents[0].path, "guide/original.md");
      assert.ok(input.documents[0].content.includes("First saved body"));
      assert.ok(!input.documents[0].content.includes("A later original body"));
      await build.locator('[data-build-action="close"]').click();
      assert.equal(await root.isVisible(), true);
      await root.locator(`[data-placement-id="${pinned.id}"] [data-placement-action="history"]`).click();
      await form.locator(".placement-history li").waitFor();
      await form.locator("[data-doc-close]").click();
      await root.locator(`[data-placement-id="${pinned.id}"] [data-placement-action="edit"]`).click();
      assert.equal(await form.locator("#doc-link-space").isDisabled(), true);
      await form.locator("#doc-path").fill("guide/reviewed.md");
      await page.waitForFunction(() => !document.querySelector('#documentPlacementDialog [type="submit"]')?.disabled);
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      await root.locator(`[data-placement-id="${pinned.id}"] code`).filter({ hasText: "guide/reviewed.md" }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-placement-action")), "edit");
      const overflow = await root.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      assert.equal(overflow, false);
      assert.ok(!(await root.innerText()).match(/documents\.[a-zA-Z]/));
      await page.screenshot({ path: `${out}/${width}-${locale}-destinations.png` });
      if (width === 1440) {
        await page.setViewportSize({ width: 320, height: 760 });
        assert.equal(await root.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
        await page.screenshot({ path: `${out}/320-en-destinations.png` });
        await page.setViewportSize({ width, height: 960 });
      }
      await root.locator(`[data-placement-id="${pinned.id}"] [data-placement-action="remove"]`).click();
      await form.locator('[type="submit"]').click();
      await form.waitFor({ state: "hidden" });
      await root.locator(`[data-placement-id="${pinned.id}"]`).waitFor({ state: "detached" });
      const retained = await api("/api/documents/detail?id=" + source.document.id, undefined, "get");
      assert.equal(retained.revision.locale, "en-GB");
      assert.ok(retained.revision.content.includes("A later original body"));
      assert.ok(retained.revision.body);
      await root.locator('[data-placement-action="close"]').click();
      await page.reload();
      await page.locator("#documentReadTitle").waitFor();
      assert.equal(await page.locator("#documentLanguage").innerText(), "en-GB");
      assert.deepEqual(errors, []);
      checks.push({
        width,
        locale,
        retrySameId: true,
        pinnedRichBuild: true,
        sourceLanguageDurable: true,
        originalPreserved: true,
        overflow: false,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  assert.equal(
    fixture.app.calls().some((call) => call.method === "turn/start"),
    false,
  );
  await writeFile(out + "/verified.json", JSON.stringify({ checks }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await fixture.dispose();
}
