import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { openOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";
import { documentAuthor } from "../../src/server/documents/files/commands.js";
import { Database } from "bun:sqlite";

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
  out = ".artifacts/knowledge-workflow";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get", headers) => {
        const response = await context.request[method](app.base + path, { data, headers });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        projects = await api("/api/projects", {
          code: "knowledge-" + width,
          name: "Knowledge notes",
          revision: catalog.revision,
        }),
        project = projects.projects.find((p) => p.code === "knowledge-" + width);
      const createDocument = async (title, text) => {
        const tree = await api("/api/project-document-tree?project=" + project.id),
          created = await api("/api/project-document-tree/documents", {
            id: crypto.randomUUID(),
            projectId: project.id,
            treeVersion: tree.version,
            title,
            locale: "en",
            parentId: null,
          }),
          documentId = created.operation.documentId,
          query = new URLSearchParams({ project: project.id, id: documentId }),
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
                  document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
                },
              },
            },
            "put",
          );
        await api("/api/project-documents/checkpoints?" + query, {
          operationId: crypto.randomUUID(),
          revisionId: opened.saved.revision.id,
          draftVersion: saved.receipt.version,
        });
        return documentId;
      };
      const id = await createDocument(
        "Reliable document indexing",
        "Persist saved source versions before activating a new search generation.",
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      let conflictedRead = false,
        persistentConflict = false,
        rejectedReads = 0;
      await page.route("**/api/knowledge/tasks/detail?**", async (route) => {
        const response = await route.fetch();
        if (
          (!conflictedRead || persistentConflict) &&
          response.ok() &&
          (await response.json()).task.state === "review"
        ) {
          conflictedRead = true;
          if (persistentConflict) rejectedReads++;
          return route.fulfill({ response, status: 409, json: { code: "conflict" } });
        }
        return route.fulfill({ response });
      });
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#documentReadTitle").waitFor();
      if (width < 700 && !(await page.locator(".document-workspace-more > summary").isVisible()))
        await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(".document-workspace-more > summary").click();
      let releaseModule, observeModule;
      const moduleGate = new Promise((resolve) => {
          releaseModule = resolve;
        }),
        moduleObserved = new Promise((resolve) => {
          observeModule = resolve;
        });
      await page.route("**/knowledge.bundle.js", async (route) => {
        observeModule();
        await moduleGate;
        return route.continue();
      });
      await page.locator('[data-authoring-action="knowledge"]').click();
      await moduleObserved;
      await page.locator("[data-knowledge-loading]").waitFor();
      await page.locator(".knowledge-panel[open] [data-knowledge-close]").click();
      releaseModule();
      await page.evaluate(async () => {
        await import("/knowledge.bundle.js");
      });
      assert.equal(await page.locator(".knowledge-panel[open]").count(), 0);
      await page.unroute("**/knowledge.bundle.js");
      if (width < 700 && !(await page.locator(".document-workspace-more > summary").isVisible()))
        await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(".document-workspace-more > summary").click();
      await page.locator('[data-authoring-action="knowledge"]').click();
      const panel = page.locator(".knowledge-panel[open]");
      await panel.waitFor();
      await waitFor(() => panel.locator("[data-knowledge-submit]").isEnabled());
      const toggle = panel.locator("[data-knowledge-automatic]");
      assert.equal(await toggle.isChecked(), false);
      assert.equal(await panel.locator("[data-knowledge-filter]").isVisible(), true);
      await page.screenshot({ path: out + "/settings-" + width + ".png" });
      await panel.locator('[name="pf-knowledge-purpose"]').fill("ask-audience: Make a reusable guide for maintainers.");
      await panel.locator("[data-knowledge-submit]").click();
      await panel.locator("[data-knowledge-answer]").waitFor();
      await panel.locator("[data-knowledge-answer] textarea").fill("Developers maintaining a document workspace.");
      await panel.locator("[data-knowledge-answer] [type=submit]").click();
      await panel
        .locator('[data-knowledge-action="approve"]')
        .waitFor()
        .catch(async (error) => {
          console.error("Approval view did not recover", {
            width,
            conflictedRead,
            tasks: await api("/api/knowledge/tasks?project=" + project.id),
            view: await panel.innerText(),
          });
          throw error;
        });
      assert.ok(conflictedRead);
      // Explicit terminal-history fixtures exercise pagination without running additional model tasks.
      const historyTask = (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0];
      const historyDb = new Database(join(app.dir, "panda-state", "data", "knowledge.sqlite"));
      try {
        const row = historyDb.query("SELECT * FROM knowledge_tasks WHERE id=?").get(historyTask.id),
          columns = Object.keys(row),
          insert = historyDb.query(
            "INSERT INTO knowledge_tasks(" + columns.join(",") + ") VALUES(" + columns.map(() => "?").join(",") + ")",
          );
        historyDb
          .transaction(() => {
            for (let i = 0; i < 60; i++) {
              const id = crypto.randomUUID(),
                fixture = {
                  ...row,
                  id,
                  title: "History example " + String(i + 1).padStart(2, "0"),
                  signature: id,
                  state: "failed",
                  failure: "interrupted",
                  draftDigest: null,
                  outputDigest: null,
                  result: null,
                  token: null,
                  leaseUntil: null,
                  autoEligible: 0,
                  createdAt: row.createdAt - (i + 1) * 1000,
                  updatedAt: row.createdAt - (i + 1) * 1000,
                };
              insert.run(...columns.map((k) => fixture[k]));
            }
          })
          .immediate();
      } finally {
        historyDb.close();
      }
      await panel.locator('[data-knowledge-action="refresh"]').click();
      await waitFor(() => panel.locator("[data-knowledge-older]").isEnabled());
      await page.screenshot({ path: out + "/manual-review-" + width + ".png" });
      await panel.locator('[data-knowledge-action="edit"]').click();
      await panel.locator('[name="pf-knowledge-title"]').fill("Human reviewed indexing knowledge");
      await panel.locator("[data-knowledge-older]").click();
      assert.equal(
        await panel.locator('[name="pf-knowledge-title"]').inputValue(),
        "Human reviewed indexing knowledge",
      );
      assert.equal(
        await panel.locator("[data-knowledge-newer]").isDisabled(),
        true,
        "An unsaved draft blocks page navigation",
      );
      persistentConflict = true;
      await panel.locator("[data-knowledge-edit] [type=submit]").click();
      await panel.locator("[data-knowledge-detail-retry]:enabled").waitFor();
      assert.equal(rejectedReads, 3, "A terminal task read must stop after its bounded conflict retries");
      await panel.locator("[data-knowledge-detail-retry]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/detail-retry-" + width + ".png" });
      persistentConflict = false;
      await panel.locator("[data-knowledge-detail-retry]").focus();
      await panel.locator("[data-knowledge-detail-retry]").press("Enter");
      await panel.locator('[data-knowledge-action="approve"]').waitFor();
      assert.equal(
        await panel.locator('[data-knowledge-action="edit"]').evaluate((button) => document.activeElement === button),
        true,
      );
      await panel.locator('[data-knowledge-action="approve"]').click();
      await waitFor(
        async () => (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0]?.state === "completed",
      ).catch(async (error) => {
        console.error("Manual knowledge save did not finish", {
          width,
          tasks: await api("/api/knowledge/tasks?project=" + project.id),
          view: await panel.innerText(),
        });
        await page.screenshot({ path: out + "/manual-save-failure-" + width + ".png" });
        throw error;
      });
      await toggle.check();
      await waitFor(
        async () => (await api("/api/knowledge/review-policy?project=" + project.id)).policy.automatic === true,
      );
      const directory = join(app.dir, "panda-state", "data", "document-content", "projects", project.id),
        manualTask = (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0],
        priorPath = join(directory, "knowledge", manualTask.result.id + ".md"),
        manualGuidance = '<img src=x onerror="window.__knowledgeInjected=true"> Keep operator guidance.',
        priorText =
          (await readFile(priorPath, "utf8")) +
          "\n" +
          manualGuidance +
          "\n" +
          "Historical review context. ".repeat(3000);
      const owned = await openOwnedProjectDirectory(
        join(app.dir, "panda-state", "data", "document-content"),
        project.id,
      );
      await new ProjectContentCoordinator(owned).plan(
        {
          operationId: crypto.randomUUID(),
          author: documentAuthor("fixture-reviewer"),
          message: "Preserve manual knowledge guidance",
          intent: "fixture-manual-guidance",
        },
        async () => ({ changes: [{ path: "knowledge/" + manualTask.result.id + ".md", content: priorText }] }),
      );
      await panel
        .locator('[name="pf-knowledge-purpose"]')
        .fill("Update facts while preserving the prior human guidance.");
      await panel.locator("[data-knowledge-submit]").click();
      await panel
        .locator("[data-knowledge-previous-ack]")
        .waitFor()
        .catch(async (error) => {
          console.error("Protected update did not reach comparison", {
            width,
            tasks: await api("/api/knowledge/tasks?project=" + project.id),
            view: await panel.innerText(),
          });
          await page.screenshot({ path: out + "/protected-update-failure-" + width + ".png" });
          throw error;
        });
      assert.equal(await panel.locator('[data-knowledge-action="approve"]').isDisabled(), true);
      assert.equal(await panel.locator("[data-knowledge-previous-ack]").isDisabled(), true);
      const protectedTask = (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0],
        protectedDetail = await api("/api/knowledge/tasks/detail?id=" + protectedTask.id),
        historical = protectedDetail.sources.find((source) => source.kind === "user-input"),
        updatedDraft = {
          ...protectedDetail.draft,
          claims: protectedDetail.draft.claims.map((claim) => ({
            ...claim,
            evidence: claim.evidence.map(({ sourceId, version, quote, start, section }) => ({
              sourceId,
              version,
              quote,
              start,
              ...(section === undefined ? {} : { section }),
            })),
          })),
        };
      assert.equal(protectedTask.manualReviewRequired, true);
      assert.equal(protectedTask.automaticReview, null);
      assert.equal(protectedDetail.previous.reviewRequired, true);
      const unacknowledged = await context.request.post(app.base + "/api/knowledge/tasks/approve", {
        data: { id: protectedTask.id, revision: protectedTask.reviewRevision },
      });
      assert.equal(unacknowledged.status(), 409);
      assert.equal(await readFile(priorPath, "utf8"), priorText);
      updatedDraft.claims.push({
        id: "retained-guidance",
        kind: "user",
        text: manualGuidance,
        evidence: [{ sourceId: historical.id, version: historical.version, quote: manualGuidance }],
      });
      await api("/api/knowledge/tasks/edit", {
        id: protectedTask.id,
        revision: protectedTask.reviewRevision,
        draft: updatedDraft,
      });
      await panel.locator('[data-knowledge-action="refresh"]').click();
      await waitFor(
        async () => (await api("/api/knowledge/tasks/detail?id=" + protectedTask.id)).task.reviewRevision === 2,
      );
      await waitFor(async () =>
        (await panel.locator("[data-knowledge-detail]").textContent()).includes(manualGuidance),
      );
      let rejectPrevious = true,
        previousPages = 0;
      await page.route("**/api/knowledge/tasks/previous?**", (route) => {
        if (rejectPrevious) {
          rejectPrevious = false;
          return route.fulfill({ status: 503, json: { code: "unavailable" } });
        }
        previousPages++;
        return route.continue();
      });
      await panel.locator(".knowledge-previous details > summary").click();
      await panel.locator("[data-knowledge-previous-content] button").click();
      await panel.locator("[data-knowledge-previous-ack]:enabled").waitFor();
      assert.ok(previousPages >= 2);
      assert.equal(await panel.locator("[data-knowledge-previous-content] pre").textContent(), priorText);
      assert.equal(
        await panel.locator("[data-knowledge-previous-content] img, [data-knowledge-previous-content] script").count(),
        0,
      );
      assert.equal(await page.evaluate(() => window.__knowledgeInjected === true), false);
      assert.equal(await panel.locator('[data-knowledge-action="approve"]').isDisabled(), true);
      await panel.locator("[data-knowledge-previous-ack]").check();
      assert.equal(await panel.locator('[data-knowledge-action="approve"]').isEnabled(), true);
      const comparisonGeometry = await panel.evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth + 1,
        body: document.documentElement.scrollWidth > innerWidth + 1,
        confirmation: element.querySelector("[data-knowledge-previous-ack]").closest("label").getBoundingClientRect()
          .height,
      }));
      assert.equal(comparisonGeometry.overflow, false);
      assert.equal(comparisonGeometry.body, false);
      assert.ok(comparisonGeometry.confirmation >= 44);
      await page.screenshot({ path: out + "/protected-update-" + width + ".png" });
      await panel.locator('[data-knowledge-action="approve"]').click();
      await waitFor(
        async () => (await api("/api/knowledge/tasks/status?id=" + protectedTask.id)).task.state === "completed",
      );
      const retained = JSON.parse(
        await readFile(join(directory, "knowledge", manualTask.result.id + ".panda.json"), "utf8"),
      );
      assert.equal(retained.draft.claims.find((claim) => claim.id === "retained-guidance").text, manualGuidance);
      assert.ok((await readFile(priorPath, "utf8")).includes("Keep operator guidance"));
      assert.ok((await readFile(priorPath, "utf8")).includes("\\<img"));
      assert.equal(await page.evaluate(() => window.__knowledgeInjected === true), false);
      await page.unroute("**/api/knowledge/tasks/previous?**");
      await panel.locator("[data-knowledge-close]").click();
      const autoDocument = await createDocument(
        "Automatic source guide",
        "Only activate a search index after its saved source commit is durable.",
      );
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: autoDocument }));
      await page.locator("#documentReadTitle").waitFor();
      if (width < 700 && !(await page.locator(".document-workspace-more > summary").isVisible()))
        await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(".document-workspace-more > summary").click();
      await page.locator('[data-authoring-action="knowledge"]').click();
      await waitFor(() => panel.locator("[data-knowledge-submit]").isEnabled());
      await panel.locator('[name="pf-knowledge-purpose"]').fill("Independently review a new source guide.");
      await panel.locator("[data-knowledge-submit]").click();
      const auto = await waitFor(async () => {
        const task = (await api("/api/knowledge/tasks?project=" + project.id)).tasks[0];
        return task?.state === "completed" && task.automaticReview?.state === "passed" ? task : null;
      }).catch(async (error) => {
        const tasks = await api("/api/knowledge/tasks?project=" + project.id),
          task = tasks.tasks[0];
        console.error("Automatic knowledge review did not finish", {
          width,
          tasks,
          review: task ? await api("/api/knowledge/tasks/review?id=" + task.id) : null,
          view: await panel.innerText(),
        });
        await page.screenshot({ path: out + "/automatic-save-failure-" + width + ".png" });
        throw error;
      });
      await waitFor(
        async () =>
          (await panel.locator("[data-knowledge-task-state]").textContent()) === (locale === "en" ? "Saved" : "已保存"),
      );
      await panel.locator(".knowledge-review-report > summary").click();
      await page.screenshot({ path: out + "/automatic-review-" + width + ".png" });
      const detail = await api("/api/knowledge/tasks/review?id=" + auto.id);
      assert.equal(detail.report.verdict, "approve");
      assert.equal(detail.report.claims.length, 1);
      const record = JSON.parse(await readFile(join(directory, "knowledge", auto.result.id + ".panda.json"), "utf8"));
      assert.equal(record.approval.mode, "automatic");
      assert.equal(record.approval.reviewId, detail.report.id);
      assert.equal(record.previousVersion, null);
      assert.equal(record.taskId, auto.id);
      const committed = execFileSync(
        "git",
        ["-C", directory, "show", auto.result.commit + ":knowledge/" + record.id + ".panda.json"],
        { encoding: "utf8" },
      );
      assert.equal(JSON.parse(committed).version, record.version);
      assert.equal(
        (
          await context.request.put(app.base + "/api/knowledge/review-policy", {
            headers: { origin: "https://foreign.example" },
            data: { project: project.id, automatic: false, revision: 1 },
          })
        ).status(),
        401,
      );
      assert.equal((await api("/api/knowledge/review-policy?project=" + project.id)).policy.automatic, true);
      const geometry = await panel.evaluate((element) => ({
        panel: element.getBoundingClientRect().toJSON(),
        overflow: element.scrollWidth > element.clientWidth + 1,
        body: document.documentElement.scrollWidth > innerWidth + 1,
        toggle: element.querySelector("[data-knowledge-automatic]").closest("label").getBoundingClientRect().height,
      }));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.body, false);
      assert.ok(geometry.toggle >= 40);
      let rejectRecord = true;
      await page.route("**/api/knowledge/records/detail?**", (route) => {
        if (rejectRecord) {
          rejectRecord = false;
          return route.fulfill({ status: 409, json: { code: "conflict" } });
        }
        return route.continue();
      });
      await panel.locator(".knowledge-record-link").click();
      assert.equal(await page.locator("[data-knowledge-compose]").count(), 0);
      const approved = page.locator(".knowledge-record[open]");
      await approved.locator("[data-knowledge-record-retry]").click();
      await approved.locator(".knowledge-claim").waitFor();
      assert.equal(await approved.locator("[data-knowledge-record-title]").textContent(), record.draft.title);
      assert.equal(await approved.locator("[data-knowledge-submit],[data-knowledge-action]").count(), 0);
      await approved.locator(".knowledge-claim details > summary").click();
      assert.ok(
        (await approved.locator("blockquote").textContent()).includes(record.draft.claims[0].evidence[0].quote),
      );
      const recordGeometry = await approved.evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth + 1,
        body: document.documentElement.scrollWidth > innerWidth + 1,
        close: element.querySelector("[data-knowledge-close]").getBoundingClientRect().height,
      }));
      assert.equal(recordGeometry.overflow, false);
      assert.equal(recordGeometry.body, false);
      assert.ok(recordGeometry.close >= 44);
      await page.screenshot({ path: out + "/approved-record-" + width + ".png" });
      await approved.locator(".knowledge-record-sources a").first().click();
      await page.waitForURL(
        (url) => url.searchParams.get("document") === autoDocument && !url.searchParams.has("knowledge"),
      );
      assert.equal(await page.locator(".knowledge-record[open]").count(), 0);
      await page.locator("#documentReadTitle").waitFor();
      let releaseRecord, observeRecord, settleRecord;
      const recordGate = new Promise((resolve) => {
          releaseRecord = resolve;
        }),
        recordObserved = new Promise((resolve) => {
          observeRecord = resolve;
        }),
        recordSettled = new Promise((resolve) => {
          settleRecord = resolve;
        });
      await page.route("**/api/knowledge/records/detail?**", async (route) => {
        try {
          const response = await route.fetch();
          observeRecord();
          await recordGate;
          await route.fulfill({ response });
        } finally {
          settleRecord();
        }
      });
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, knowledge: record.id }));
      await recordObserved;
      await page.locator(".knowledge-record[open] [data-knowledge-close]").click();
      assert.equal(new URL(page.url()).searchParams.has("knowledge"), false);
      releaseRecord();
      await recordSettled;
      assert.equal(await page.locator(".knowledge-record[open]").count(), 0);
      assert.equal(await page.locator("[data-knowledge-record-title]").count(), 0);
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: autoDocument }));
      await page.locator("#documentReadTitle").waitFor();
      if (width < 700 && !(await page.locator(".document-workspace-more > summary").isVisible()))
        await page.locator('[data-authoring-action="reader-directory"]').click();
      await page.locator(".document-workspace-more > summary").click();
      await page.locator('[data-authoring-action="knowledge"]').click();
      await panel.waitFor();
      await waitFor(() => panel.locator("[data-knowledge-older]").isEnabled());
      const newestIds = await panel
        .locator("[data-knowledge-task]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.knowledgeTask));
      assert.equal(newestIds.length, 50);
      await panel.locator("[data-knowledge-older]").focus();
      await panel.locator("[data-knowledge-older]").press("Enter");
      await waitFor(
        async () =>
          (await panel.locator("[data-knowledge-newer]").isEnabled()) &&
          (await panel.locator("[data-knowledge-older]").isDisabled()),
      );
      const olderIds = await panel
        .locator("[data-knowledge-task]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.knowledgeTask));
      assert.ok(olderIds.length > 0 && olderIds.length < 50);
      assert.ok(olderIds.every((id) => !newestIds.includes(id)));
      assert.equal(
        await panel
          .locator('[data-knowledge-task][aria-pressed="true"]')
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await panel.locator(".knowledge-history").scrollIntoViewIfNeeded();
      await page.screenshot({ path: out + "/history-" + width + ".png" });
      const historyGeometry = await panel.evaluate((node) => ({
        overflow: node.scrollWidth > node.clientWidth + 1,
        list: node.querySelector("[data-knowledge-tasks]").getBoundingClientRect().height,
        older: node.querySelector("[data-knowledge-older]").getBoundingClientRect().height,
      }));
      assert.equal(historyGeometry.overflow, false);
      assert.ok(historyGeometry.older >= 40);
      assert.ok(historyGeometry.list <= 960 * 0.4 + 1);
      await panel.locator("[data-knowledge-newer]").click();
      await waitFor(
        async () =>
          (await panel.locator("[data-knowledge-newer]").isDisabled()) &&
          (await panel.locator("[data-knowledge-older]").isEnabled()) &&
          (await panel.locator("[data-knowledge-task]").count()) === 50,
      );
      assert.deepEqual(
        await panel
          .locator("[data-knowledge-task]")
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.knowledgeTask)),
        newestIds,
      );
      assert.deepEqual(errors, []);
    } finally {
      await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: "wait" })));
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Knowledge manual and automatic review, questions, edits, exact file/Git output, owner-scoped policy and PC/H5 layouts passed.",
  );
} finally {
  await app.dispose();
}
