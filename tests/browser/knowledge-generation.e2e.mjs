import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { join } from "node:path";
import { openOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";
import { readProjectManifest } from "../../src/server/project-content/project-manifest.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { encodeProjectDocument } from "../../src/server/project-content/document-file.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";

const app = await createAppFixture({
    applicationKnowledge: true,
    models: [
      {
        id: "fixture-knowledge",
        model: "fixture-knowledge",
        displayName: "Knowledge fixture",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  }),
  out = ".artifacts/knowledge-generation-rules";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "POST" : "GET") => {
        const response = await context.request.fetch(app.base + path, { method, data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "rules-" + width,
          name: "Knowledge rule review",
          revision: catalog.revision,
        }),
        project = created.projects.find((p) => p.code === "rules-" + width);
      const create = async (title, parentId = null) => {
        const tree = await api("/api/project-document-tree?project=" + project.id),
          created = await api("/api/project-document-tree/documents", {
            id: crypto.randomUUID(),
            projectId: project.id,
            treeVersion: tree.version,
            title,
            locale: "en",
            parentId,
          }),
          id = created.operation.documentId,
          query = new URLSearchParams({ project: project.id, id }),
          opened = await api("/api/project-documents/editor?" + query),
          saved = await api(
            "/api/project-documents/editor?" + query,
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
                        content: [
                          {
                            type: "text",
                            text: "Saved engineering decision: " + title + ". Preserve exact source versions.",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
            "PUT",
          );
        await api("/api/project-documents/checkpoints?" + query, {
          operationId: crypto.randomUUID(),
          revisionId: opened.saved.revision.id,
          draftVersion: saved.receipt.version,
        });
        return id;
      };
      const parent = await create("Engineering decisions"),
        child = await create("Private draft notes", parent);
      await create("Deployment decisions", child);
      const owned = await openOwnedProjectDirectory(
        join(app.dir, "panda-state", "data", "document-content"),
        project.id,
      );
      await new ProjectContentCoordinator(owned).plan(
        {
          operationId: crypto.randomUUID(),
          author: { name: "Rule fixture", email: "rule@example.test" },
          message: "Save catalog fixtures",
          intent: crypto.randomUUID(),
        },
        async (view) => {
          const manifest = await readProjectManifest(view, project.id);
          return {
            changes: Array.from({ length: 52 }, (_, i) => {
              const id = "zz-catalog-" + String(i).padStart(3, "0"),
                detail = projectDocumentFixture(1, id);
              detail.document.spaceId = manifest.librarySpaceId;
              return { path: projectDocumentFile(id), content: encodeProjectDocument(detail) };
            }),
          };
        },
      );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (e) => errors.push(e.message));
      let policyReads = 0;
      page.on("request", (r) => {
        if (r.url().includes("/api/knowledge/generation-policy")) policyReads++;
      });
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: parent }));
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      if (width < 700 && !(await page.locator(".document-workspace-more > summary").isVisible()))
        await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(".document-workspace-more > summary").click();
      await page.locator('[data-authoring-action="knowledge"]').click();
      const panel = page.locator(".knowledge-panel[open]");
      await panel.locator("[data-knowledge-submit]:enabled").waitFor();
      assert.equal(policyReads, 0, "Rule configuration must not delay the manual knowledge view");
      await panel.locator('[data-knowledge-section="rules"]').click();
      const form = panel.locator("[data-rule-form]"),
        field = (name) => form.locator('[name="pf-knowledge-rule-' + name + '"]');
      await field("enabled").waitFor();
      await waitFor(() => field("enabled").isEnabled());
      assert.equal(await field("enabled").isChecked(), false);
      assert.equal((await api("/api/knowledge/review-policy?project=" + project.id)).policy.automatic, false);
      await form.locator("[data-rule-picker] > summary").click();
      await form
        .locator('[data-rule-id="' + parent + '"]')
        .first()
        .waitFor();
      const set = async () => {
        await field("enabled").check();
        await field("purpose").fill("Explain engineering decisions for maintainers.");
        await form.locator('[data-rule-source="include"][data-rule-id="' + parent + '"]').selectOption("tree");
        await form.locator('[data-rule-source="exclude"][data-rule-id="' + child + '"]').selectOption("document");
      };
      await set();
      await form.locator("[data-rule-next]").click();
      await form.locator('[data-rule-source="exclude"][data-rule-id="zz-catalog-051"]').selectOption("document");
      await form.locator("[data-rule-previous]").click();
      await waitFor(() => form.locator('[data-rule-source="include"][data-rule-id="' + parent + '"]').count());
      assert.equal(
        await form.locator('[data-rule-source="include"][data-rule-id="' + parent + '"]').inputValue(),
        "tree",
      );
      await form.locator("[data-rule-next]").click();
      assert.equal(
        await form.locator('[data-rule-source="exclude"][data-rule-id="zz-catalog-051"]').inputValue(),
        "document",
      );
      await form.locator("[data-rule-previous]").click();
      await form.locator('[data-rule-source="include"][data-rule-id="' + parent + '"]').waitFor();
      await page.screenshot({ path: out + "/rule-sources-" + width + ".png" });
      assert.equal(await form.locator("[data-rule-apply]").isDisabled(), true);
      let release, observed;
      const gate = new Promise((resolve) => (release = resolve)),
        entered = new Promise((resolve) => (observed = resolve));
      await page.route(
        "**/api/knowledge/generation-preview",
        async (route) => {
          const response = await route.fetch();
          observed();
          await gate;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      await form.locator("[data-rule-preview]").click();
      await entered;
      const cancelled = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().endsWith("/api/knowledge/generation-preview"),
      });
      await field("purpose").fill("Revised intended audience");
      release();
      await cancelled;
      assert.equal(
        await form.locator("[data-rule-apply]").isDisabled(),
        true,
        "A preview for old inputs must not approve new inputs",
      );
      await form.locator("[data-rule-preview]").click();
      await waitFor(() => form.locator("[data-rule-apply]").isEnabled());
      assert.ok(
        (await form.locator("[data-rule-preview-notice]").innerText()).includes("2"),
        "A single-document exclusion must retain descendants",
      );
      await form.locator("[data-rule-picker] > summary").click();
      await panel.locator(".knowledge-scroll").evaluate((e) => (e.scrollTop = 0));
      await page.screenshot({ path: out + "/rules-" + width + ".png" });
      await form.locator("[data-rule-apply]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/rules-actions-" + width + ".png" });
      await create("Unrelated source created after preview");
      await form.locator("[data-rule-apply]").click();
      await waitFor(async () => !(await form.locator("[data-rule-reload]").isDisabled()));
      assert.equal((await api("/api/knowledge/generation-policy?project=" + project.id)).policy.revision, 0);
      assert.equal(await form.locator("[data-rule-apply]").isDisabled(), true);
      await form.locator("[data-rule-reload]").click();
      await waitFor(() => field("enabled").isEnabled());
      await form.locator("[data-rule-picker] > summary").click();
      await set();
      await form.locator("[data-rule-preview]").click();
      await waitFor(() => form.locator("[data-rule-apply]").isEnabled());
      await page.route(
        "**/api/knowledge/generation-policy",
        async (route) => {
          await route.fetch();
          await route.abort("failed");
        },
        { times: 1 },
      );
      await form.locator("[data-rule-apply]").click();
      await waitFor(
        async () => (await api("/api/knowledge/generation-policy?project=" + project.id)).policy.revision === 1,
      );
      await waitFor(async () =>
        (await panel.locator("[data-rule-notice]").innerText()).includes(
          locale === "en" ? "The rule may have changed" : "规则可能已经变化",
        ),
      );
      assert.equal(
        await form.locator("[data-rule-apply]").isDisabled(),
        true,
        "An ambiguous save must not be replayed as a second rule",
      );
      await form.locator("[data-rule-reload]").click();
      await waitFor(
        async () =>
          (await field("enabled").isEnabled()) &&
          (await field("enabled").isChecked()) &&
          !(await panel.locator("[data-rule-notice]").innerText()),
      );
      assert.equal(
        (await api("/api/knowledge/tasks?project=" + project.id)).tasks.length,
        0,
        "Unselected backfill must not enqueue old saved versions",
      );
      assert.equal((await api("/api/knowledge/review-policy?project=" + project.id)).policy.automatic, false);
      const next = await create("New saved deployment decision", parent);
      await waitFor(async () =>
        (await api("/api/knowledge/tasks?project=" + project.id)).tasks.some(
          (t) => t.origin?.documentId === next && t.state === "review",
        ),
      );
      await panel.locator('[data-knowledge-section="tasks"]').click();
      await panel.locator('[data-knowledge-action="refresh"]').click();
      await panel.locator("[data-knowledge-task]").first().click();
      await panel.locator('[data-knowledge-action="edit"]').waitFor();
      assert.ok(
        (await panel.locator("[data-knowledge-detail]").innerText()).includes(
          locale === "en" ? "Rule · revision 1" : "规则触发",
        ),
      );
      await page.screenshot({ path: out + "/rule-task-" + width + ".png" });
      await panel.locator('[data-knowledge-action="edit"]').click();
      await panel.locator('[name="pf-knowledge-title"]').fill("Human-owned decisions");
      await panel.locator("[data-knowledge-edit] [type=submit]").click();
      await waitFor(
        async () => (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0]?.origin?.manual === true,
      );
      await panel.locator('[data-knowledge-section="rules"]').click();
      await field("enabled").uncheck();
      await form.locator("[data-rule-apply]").click();
      await waitFor(async () => !(await api("/api/knowledge/generation-policy?project=" + project.id)).policy.enabled);
      const tasks = (await api("/api/knowledge/tasks?project=" + project.id)).tasks;
      assert.equal(tasks[0].state, "review");
      assert.equal(tasks[0].origin.manual, true);
      const geometry = await panel.evaluate((e) => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollerOverflow:
          e.querySelector(".knowledge-scroll").scrollWidth > e.querySelector(".knowledge-scroll").clientWidth,
        close: e.querySelector("[data-knowledge-close]").getBoundingClientRect().height,
      }));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.scrollerOverflow, false);
      assert.ok(geometry.close >= 44);
      if (width === 390) {
        for (const narrow of [320, 767]) {
          await page.setViewportSize({ width: narrow, height: 960 });
          assert.equal(
            await panel.evaluate(
              (e) =>
                document.documentElement.scrollWidth > innerWidth ||
                e.querySelector(".knowledge-scroll").scrollWidth > e.querySelector(".knowledge-scroll").clientWidth,
            ),
            false,
          );
          await panel.locator(".knowledge-scroll").evaluate((e) => (e.scrollTop = 0));
          await page.screenshot({ path: out + "/rules-" + narrow + ".png" });
        }
      }
      assert.deepEqual(errors, []);
      await panel.locator("[data-knowledge-close]").click();
      await page.close();
    } catch (error) {
      const current = context.pages().at(-1);
      if (current) {
        await current.screenshot({ path: out + "/failure-" + width + ".png" });
        console.error(
          "Rule workflow failed",
          width,
          await current
            .locator(".knowledge-panel[open]")
            .innerText()
            .catch(() => "Knowledge panel did not open"),
        );
      }
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Knowledge generation rules: deferred entry, scoped preview, stale-input/source guards, explicit baseline, rule origin and manual adoption verified on PC/H5.",
  );
} finally {
  await app.dispose();
}
