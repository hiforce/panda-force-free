import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

let release = () => {},
  hold = false;
const requests = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const payload = await req.json();
    requests.push(payload);
    if (hold)
      await new Promise((resolve) => {
        release = resolve;
        req.signal.addEventListener("abort", resolve, { once: true });
      });
    const input = JSON.parse(payload.input[0].content[0].text);
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                edits: input.segments.map((segment) => ({
                  segmentId: segment.segmentId,
                  before: segment.text,
                  after: segment.text.replace("are", "is"),
                  reason: "Agreement",
                })),
              }),
            },
          ],
        },
      ],
    });
  },
});
const app = await createAppFixture({
  extraEnvironment: ({ dir }) => {
    const file = join(dir, "processing.json");
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        processors: [
          {
            kind: "responses",
            id: "review",
            model: "fixture-editor",
            endpoint: `http://127.0.0.1:${provider.port}/responses`,
            authentication: "none",
          },
        ],
      }),
    );
    return { PANDA_FORCE_EDITORIAL_CONFIG_FILE: file };
  },
});
await mkdir(".artifacts/file-editorial-browser", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width === 390 ? "dark" : "light",
      });
      await app.signIn(context);
      const api = async (path, data, method = data === undefined ? "get" : "post") => {
        const response = await context.request[method](app.base + path, { data, headers: { Origin: app.base } });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalogState = await api("/api/projects"),
        created = await api("/api/projects", {
          name: "File review",
          code: "file-review-" + width,
          revision: catalogState.revision,
        });
      const project = created.projects.find((item) => item.code === "file-review-" + width),
        catalog = new ProjectCatalog(join(app.dir, "panda-state/data/projects.sqlite"));
      try {
        assert.equal(new ProjectDocumentStorage(catalog.db).files(project.id), true);
      } finally {
        catalog.close();
      }
      const tree = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: 0,
        title: "A file original",
        locale: "en",
        parentId: null,
      });
      const id = tree.operation.documentId,
        query = new URLSearchParams({ project: project.id, id }),
        opened = await api("/api/project-documents/editor?" + query);
      const body = {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "This are  a test.  ", marks: [{ type: "bold" }, { type: "underline" }] },
              ],
            },
            { type: "codeBlock", content: [{ type: "text", text: "const  protected = 1;" }] },
          ],
        },
      };
      const draft = await api(
        "/api/project-documents/editor?" + query,
        {
          operationId: crypto.randomUUID(),
          version: opened.draft.version,
          baseRevisionId: opened.draft.baseRevisionId,
          working: { ...opened.working, body },
        },
        "put",
      );
      await api("/api/project-documents/checkpoints?" + query, {
        operationId: crypto.randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.receipt.version,
      });
      const page = await context.newPage(),
        errors = [],
        legacy = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          ["/api/documents/detail", "/api/document-spaces", "/api/document-placements"].includes(
            new URL(request.url()).pathname,
          )
        )
          legacy.push(request.url());
      });
      const manager = page.locator("#documentPublicationDialog"),
        review = page.locator("#editorialDialog");
      const openOriginal = async () => {
        await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator("#documentReadTitle").waitFor();
      };
      const openReview = async () => {
        await page.locator('[data-doc-action="publishing"]').click();
        await manager.locator('[data-placement-action="spacing"]:not([disabled])').click();
        await review.locator('[data-editorial-action="prepare"]:not([disabled])').waitFor();
        await review.locator("#editorialProcessor option").waitFor({ state: "attached" });
      };
      await openOriginal();
      await openReview();
      await review.locator("[data-editorial-edit]").first().waitFor();
      assert.equal(await review.locator("[data-editorial-edit]").count(), 2);
      assert.equal(await review.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      const before = (
        await api("/api/document-editorial/history?" + new URLSearchParams({ project: project.id, document: id }))
      ).reviews[0];
      assert.equal(before.source.projectId, project.id);
      await review.locator("[data-editorial-edit]").first().check();
      let lost = false;
      await page.route(
        (url) => url.pathname === "/api/document-editorial/accept",
        async (route) => {
          if (!lost) {
            lost = true;
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            return route.abort("failed");
          }
          return route.continue();
        },
      );
      await review.locator('[data-editorial-action="apply"]').click();
      await page.waitForFunction(() => document.querySelector("#editorialStatus")?.dataset.error === "true");
      assert.equal(await review.locator("[data-editorial-edit]").first().isDisabled(), true);
      assert.equal((await api("/api/project-documents/source?" + query)).document.revision, 3);
      await review.locator('[data-editorial-action="apply"]').click();
      await review.waitFor({ state: "hidden" });
      await manager.waitFor({ state: "hidden" });
      await waitFor(async () =>
        (await page.locator(".document-rich-content").innerText()).includes("This are a test."),
      );
      const spacing = await api("/api/project-documents/source?" + query);
      assert.equal(spacing.document.revision, 3);
      assert.equal(spacing.revision.body.document.content[0].content[0].text, "This are a test.  ");
      assert.deepEqual(
        spacing.revision.body.document.content[0].content[0].marks,
        body.document.content[0].content[0].marks,
      );
      assert.deepEqual(spacing.revision.body.document.content[1], body.document.content[1]);
      await openReview();
      await review.locator(".editorial-model-controls summary").click();
      hold = true;
      const count = requests.length;
      await review.locator('[data-editorial-action="model-submit"]').click();
      await waitFor(() => requests.length === count + 1);
      const jobs = await api(
        "/api/document-editorial/jobs?" + new URLSearchParams({ project: project.id, document: id }),
      );
      assert.equal(jobs.jobs.length, 1);
      assert.equal(jobs.jobs[0].source.projectId, project.id);
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      await openReview();
      await review.locator('[data-editorial-state="queued"], [data-editorial-state="running"]').waitFor();
      hold = false;
      release();
      await review.locator('[data-editorial-state="succeeded"]').waitFor();
      await review.locator('[data-editorial-action="model-view"]').click();
      await review.locator("[data-editorial-edit]").waitFor();
      assert.equal(await review.locator("[data-editorial-edit]").count(), 1);
      await review.locator("[data-editorial-edit]").check();
      await review.locator('[data-editorial-action="apply"]').click();
      await review.waitFor({ state: "hidden" });
      await manager.waitFor({ state: "hidden" });
      await waitFor(async () => (await page.locator(".document-rich-content").innerText()).includes("This is a test."));
      const final = await api("/api/project-documents/source?" + query);
      assert.equal(final.document.revision, 4);
      assert.equal(final.revision.body.document.content[0].content[0].text, "This is a test.  ");
      assert.deepEqual(final.revision.body.document.content[1], body.document.content[1]);
      await openReview();
      await review.locator("#editorialHistory").selectOption(before.id);
      await review.locator(".editorial-commit code").waitFor();
      assert.match(await review.locator(".editorial-commit code").innerText(), /^[a-f0-9]{40}$/);
      assert.equal(await review.locator('[data-editorial-action="apply"]').isDisabled(), true);
      assert.doesNotMatch(await review.innerText(), /editorial\.[a-zA-Z]+/);
      assert.equal(await review.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      await page.screenshot({ path: `.artifacts/file-editorial-browser/${width}-receipt.png` });
      assert.deepEqual(errors, []);
      assert.deepEqual(legacy, []);
      await context.close();
      console.log(
        `${engine.name()}: scoped file spacing, uncertain retry, refreshed original, persistent model task, receipt history and formatting passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  release();
  await app.dispose();
  await provider.stop(true);
}
