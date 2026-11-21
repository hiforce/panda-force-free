import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

let behavior = "hold",
  release = () => {};
const requests = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const payload = await req.json(),
      selected = behavior;
    requests.push(payload);
    if (selected === "hold")
      await new Promise((resolve) => {
        release = resolve;
        req.signal.addEventListener("abort", resolve, { once: true });
      });
    if (selected === "invalid") return Response.json({ status: "incomplete", output: [] });
    const supplied = JSON.parse(payload.input[0].content[0].text);
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
                edits: supplied.segments.map((segment) => ({
                  segmentId: segment.segmentId,
                  before: segment.text,
                  after: selected === "long" ? "Clearer. " + "x".repeat(2500) : "This is a test.",
                  reason: "Review the revised wording.",
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
    const path = join(dir, "editorial-processing.json");
    writeFileSync(
      path,
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
    return { PANDA_FORCE_EDITORIAL_CONFIG_FILE: path };
  },
});
const out = ".artifacts/editorial-model-jobs";
await mkdir(out, { recursive: true });
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
      const api = async (path, data, method = "get") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), method + " " + path + ": " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api(
          "/api/projects",
          { code: "editorial-model-" + width, name: "Document review", revision: catalog.revision },
          "post",
        ),
        project = created.projects.find((p) => p.code === "editorial-model-" + width);
      const source = await api(
        "/api/project-documents",
        { projectId: project.id, title: "A saved original", locale: "en" },
        "post",
      );
      const saved = await api(
        "/api/documents/detail?id=" + source.document.id,
        {
          revision: 1,
          title: "A saved original",
          locale: "en",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "This are a test.", marks: [{ type: "bold" }, { type: "underline" }] },
                  ],
                },
                {
                  type: "blockquote",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Protected quotation." }] }],
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
      const review = page.locator("#editorialDialog"),
        manager = page.locator("#documentPublicationDialog");
      const openReview = async (waitForModels = true) => {
        await page.locator('[data-doc-action="publishing"]').click();
        await manager.locator('[data-placement-action="spacing"]:not([disabled])').click();
        await review.locator('[data-editorial-action="prepare"]:not([disabled])').waitFor();
        if (waitForModels) {
          await review.locator('#editorialProcessor option[value="review"]').waitFor({ state: "attached" });
          await review.locator("#editorialProcessor").selectOption("review");
        }
      };
      await page.goto(app.base + "/documents?project=" + project.id + "&document=" + source.document.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content").waitFor();
      await openReview();
      await review.locator(".editorial-model-controls summary").click();
      let lost = false;
      await page.route("**/api/document-editorial/jobs", async (route) => {
        if (route.request().method() === "POST" && !lost) {
          lost = true;
          const response = await route.fetch();
          assert.equal(response.status(), 202);
          await route.abort("failed");
        } else await route.continue();
      });
      behavior = "hold";
      const before = requests.length;
      await review.locator('[data-editorial-action="model-submit"]').click();
      await page.waitForFunction(() => document.querySelector("#editorialStatus")?.dataset.error === "true");
      assert.equal(await review.locator("#editorialMode").isDisabled(), true);
      await review.locator('[data-editorial-action="model-submit"]:not([disabled])').click();
      await review.locator('[data-editorial-state="queued"], [data-editorial-state="running"]').waitFor();
      await waitFor(() => requests.length === before + 1);
      const jobs = await api("/api/document-editorial/jobs?document=" + source.document.id);
      assert.equal(jobs.jobs.length, 1);
      assert.equal((await api("/api/documents/detail?id=" + source.document.id)).document.revision, 2);
      await review.locator('[data-editorial-action="close"]').click();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content").waitFor();
      await openReview();
      assert.equal(await review.locator(".editorial-model-controls").getAttribute("open"), "");
      await review.locator('[data-editorial-state="running"], [data-editorial-state="queued"]').waitFor();
      release();
      await review.locator('[data-editorial-state="succeeded"]').waitFor();
      await review.locator('[data-editorial-action="model-view"]').click();
      await review.locator("[data-editorial-edit]").waitFor();
      assert.equal(await review.locator("[data-editorial-edit]").count(), 1);
      assert.match(await review.locator("#editorialSuggestions").innerText(), /This·is·a·test\./);
      await review.locator("[data-editorial-edit]").check();
      await review.locator('[data-editorial-action="apply"]').click();
      await review.waitFor({ state: "hidden" });
      await manager.waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document.querySelector(".document-rich-content")?.textContent?.includes("This is a test."),
      );
      const changed = await api("/api/documents/detail?id=" + source.document.id);
      const acceptedReview = (await api("/api/document-editorial?document=" + source.document.id)).proposals.find(
        (item) => item.receipt,
      );
      assert.ok(acceptedReview);
      assert.equal(changed.document.revision, 3);
      assert.deepEqual(
        changed.revision.body.document.content[0].content[0].marks,
        saved.revision.body.document.content[0].content[0].marks,
      );
      assert.deepEqual(changed.revision.body.document.content.slice(1), saved.revision.body.document.content.slice(1));
      let failLoad = true;
      await page.route("**/api/document-editorial/processors", async (route) => {
        if (failLoad) {
          failLoad = false;
          await route.abort("failed");
        } else await route.continue();
      });
      await openReview(false);
      if ((await review.locator(".editorial-model-controls").getAttribute("open")) === null)
        await review.locator(".editorial-model-controls summary").click();
      await page.waitForFunction(() =>
        /Unable to load|无法加载/.test(document.querySelector("#editorialProcessorHint")?.textContent || ""),
      );
      await review.locator('[data-editorial-action="model-reload"]').click();
      await review.locator("#editorialMode:not([disabled])").waitFor();
      await review.locator("#editorialMode").selectOption("rewrite");
      behavior = "hold";
      const next = requests.length;
      await review.locator('[data-editorial-action="model-submit"]').click();
      await waitFor(() => requests.length === next + 1);
      await review.locator('[data-editorial-action="model-cancel"]:not([disabled])').click();
      await review.locator('[data-editorial-state="cancelled"]').waitFor();
      release();
      behavior = "invalid";
      await review.locator('[data-editorial-action="model-retry"]:not([disabled])').click();
      await review.locator('[data-editorial-state="failed"]').waitFor();
      assert.equal((await api("/api/documents/detail?id=" + source.document.id)).document.revision, 3);
      behavior = "long";
      await review.locator('[data-editorial-action="model-retry"]:not([disabled])').click();
      await review.locator('[data-editorial-state="succeeded"]').waitFor();
      await review.locator('[data-editorial-action="model-view"]').click();
      await review.locator(".editorial-diff ins").waitFor();
      assert.ok((await review.locator(".editorial-diff ins").innerText()).length > 2500);
      if (width === 390)
        await page.waitForFunction(
          () => document.querySelector("#editorialDialog .publishing-main").getBoundingClientRect().top < 200,
        );
      const firstFooter = await review.locator('[data-editorial-action="apply"]').boundingBox();
      assert.ok(
        firstFooter && firstFooter.y >= 0 && firstFooter.y + firstFooter.height <= 961,
        JSON.stringify({ width, firstFooter }),
      );
      assert.ok(
        await review.locator('[data-editorial-action="apply"]').evaluate((button) => {
          const box = button.getBoundingClientRect(),
            hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return button === hit || button.contains(hit);
        }),
      );
      await page.screenshot({ path: out + "/" + engine.name() + ".png" });
      for (const size of width === 390 ? [320, 390, 768] : [1440]) {
        await page.setViewportSize({ width: size, height: 960 });
        assert.ok(await review.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
        const button = await review.locator('[data-editorial-action="apply"]').boundingBox();
        assert.ok(button && button.x >= 0 && button.x + button.width <= size + 1);
        assert.ok(button && button.y >= 0 && button.y + button.height <= 961, JSON.stringify({ size, button }));
      }
      await page.setViewportSize({ width, height: 960 });
      await review.locator('[data-editorial-action="close"]').click();
      await manager.locator('[data-placement-action="close"]:not([disabled])').click();
      for (let index = 0; index < 51; index++)
        await api(
          "/api/document-editorial",
          {
            id: crypto.randomUUID(),
            documentId: source.document.id,
            revisionId: changed.revision.id,
            mode: "spacing",
          },
          "post",
        );
      await openReview();
      assert.equal(await review.locator(`#editorialHistory option[value="${acceptedReview.proposal.id}"]`).count(), 0);
      await review.locator('[data-editorial-action="more-history"]:not([disabled])').click();
      await review
        .locator(`#editorialHistory option[value="${acceptedReview.proposal.id}"]`)
        .waitFor({ state: "attached" });
      await review.locator("#editorialHistory").selectOption(acceptedReview.proposal.id);
      await review.locator(".editorial-state").waitFor();
      assert.equal(await review.locator('[data-editorial-action="apply"]').isDisabled(), true);
      assert.equal((await api("/api/documents/detail?id=" + source.document.id)).document.revision, 3);
      assert.doesNotMatch(await review.innerText(), /editorial\.[a-zA-Z]+/);
      assert.deepEqual(errors, []);
      assert.ok(requests.every((req) => req.tools.length === 0 && req.tool_choice === "none"));
      assert.ok(!JSON.stringify(requests).includes("Protected quotation"));
      assert.ok(!app.calls().some((entry) => entry.method === "turn/start"));
      await context.close();
      console.log(
        engine.name() +
          ": model jobs, lost reply replay, background recovery, selected review, cancellation, retry and responsive long diffs passed",
      );
    } finally {
      release();
      await browser.close();
    }
  }
} finally {
  release();
  await app.dispose();
  provider.stop(true);
}
