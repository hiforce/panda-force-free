import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { officeFixture } from "../support/office-presentation.js";

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
  out = ".artifacts/knowledge-native-generation";
await mkdir(out, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale, kind] of [
    [chromium, 1440, "en", "web"],
    [webkit, 390, "zh-CN", "slides"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "POST" : "GET") => {
        const response = await context.request.fetch(app.base + path, { method, data, headers: { origin: app.base } });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      let project = "personal";
      if (width > 700) {
        const catalog = await api("/api/projects"),
          created = await api("/api/projects", {
            code: "native-rules-" + width,
            name: "Native rule sources",
            revision: catalog.revision,
          });
        project = created.projects.find((row) => row.code === "native-rules-" + width).id;
      }
      const id = "c-" + randomUUID(),
        importSource = async (prior) => {
          const response = await context.request.post(
            app.base +
              "/api/creative-assets/import?" +
              new URLSearchParams({
                project,
                id,
                operationId: randomUUID(),
                kind,
                title: "Explicit rule source",
                locale: "en",
                name: kind === "web" ? "guide.html" : "guide.pptx",
                ...(prior ? { version: prior.version } : {}),
              }),
            {
              data:
                kind === "web"
                  ? Buffer.from(
                      "<h1>Native rule source</h1><p>Evidence follows the saved original " +
                        (prior ? "updated" : "initial") +
                        " version.</p>",
                    )
                  : Buffer.from(officeFixture({ slides: prior ? 2 : 1 }).bytes()),
              headers: { origin: app.base, "content-type": "application/octet-stream" },
            },
          );
          assert.equal(response.status(), 201, await response.text());
          return (await response.json()).asset;
        };
      let asset = await importSource();
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async () => {
        await page.goto(
          app.base +
            (project === "personal" ? "/create?" : "/project?") +
            new URLSearchParams({
              ...(project === "personal" ? {} : { id: project }),
              asset: id,
              assetVersion: asset.version,
            }),
        );
        await page.locator(".creative-asset-dialog[open] [data-asset-knowledge]").click();
        const panel = page.locator(".knowledge-panel[open]");
        await panel.locator('[data-knowledge-section="rules"]').click();
        await waitFor(() => panel.locator('[name="pf-knowledge-rule-enabled"]').isEnabled());
        return panel;
      };
      let panel = await open();
      assert.equal(await panel.locator("[data-native-enable]").isChecked(), false);
      assert.equal(await panel.locator("[data-native-scope]").isVisible(), false);
      assert.equal(await panel.locator("[data-knowledge-automatic]").isChecked(), false);
      await panel.locator('[name="pf-knowledge-rule-purpose"]').fill("Native generation guide");
      await panel.locator('[name="pf-knowledge-rule-enabled"]').check();
      await panel.locator("[data-native-enable]").check();
      await panel.locator(`[data-native-kind][value="${kind}"]`).check();
      await panel.locator("[data-native-all]").check();
      await panel.locator("[data-native-picker] > summary").click();
      const choice = panel.locator(`[data-native-choice="${id}"]`);
      await choice.selectOption("exclude");
      const preview = async () => {
        const response = page.waitForResponse((response) =>
          response.url().endsWith("/api/knowledge/generation-preview"),
        );
        await panel.locator("[data-rule-preview]").click();
        const actual = await response;
        assert.equal(actual.status(), 200);
        await waitFor(() => panel.locator("[data-rule-apply]").isEnabled());
        return actual.json();
      };
      assert.equal((await preview()).count, 0);
      await choice.selectOption("include");
      await panel.locator("[data-native-search]").fill("no-matching-source");
      await choice.waitFor({ state: "detached" });
      assert.match(await panel.locator("[data-native-summary]").innerText(), /1/);
      await panel.locator("[data-native-search]").fill("");
      await choice.waitFor();
      assert.equal(await choice.inputValue(), "include");
      assert.equal((await preview()).count, 1);
      await panel.locator("[data-rule-native]").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
      await page.screenshot({ path: out + "/rules-" + width + ".png" });
      const applied = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/knowledge/generation-policy") && response.request().method() === "PUT",
      );
      await panel.locator("[data-rule-apply]").click();
      assert.equal((await applied).status(), 200);
      const policy = (await api("/api/knowledge/generation-policy?project=" + project)).policy;
      assert.equal(policy.selection.all, false);
      assert.deepEqual(policy.selection.documents, []);
      assert.deepEqual(policy.selection.originals, { contentKinds: [kind], all: true, ids: [id], exclude: [] });
      assert.equal((await api("/api/knowledge/review-policy?project=" + project)).policy.automatic, false);
      assert.equal((await api("/api/knowledge/tasks?project=" + project)).tasks.length, 0);
      let releaseDetail = () => {},
        detailReads = 0;
      const detailGate = new Promise((resolve) => {
        releaseDetail = resolve;
      });
      if (width < 700)
        await page.route("**/api/knowledge/tasks/detail?**", async (route) => {
          detailReads++;
          await detailGate;
          await route.continue();
        });
      asset = await importSource(asset);
      let task;
      await waitFor(
        async () => {
          task = (await api("/api/knowledge/tasks?project=" + project)).tasks[0];
          return task?.state === "review";
        },
        { timeout: 25000 },
      );
      assert.equal(task.origin.sourceId, id);
      assert.equal(task.origin.sourceKind, kind);
      assert.equal("documentId" in task.origin, false);
      await panel.locator('[data-knowledge-section="tasks"]').click();
      assert.ok(await panel.locator(".knowledge-scroll").evaluate((element) => element.scrollTop <= 1));
      if (width < 700) await waitFor(() => detailReads > 0);
      const existingReads = detailReads;
      await panel.locator(`[data-knowledge-task="${task.id}"]`).click();
      if (width < 700) {
        assert.equal(detailReads, existingReads);
        releaseDetail();
      }
      await panel.locator('[data-knowledge-action="approve"]').waitFor();
      if (width < 700) {
        await waitFor(async () => {
          const detail = panel.locator("[data-knowledge-detail]"),
            box = await detail.boundingBox();
          return box && box.y < 600 && (await detail.evaluate((element) => element === document.activeElement));
        });
      }
      await page.screenshot({ path: out + "/task-" + width + ".png" });
      await panel.locator("[data-knowledge-close]").click();
      panel = await open();
      assert.equal(await panel.locator("[data-native-enable]").isChecked(), true);
      assert.equal(await panel.locator(`[data-native-kind][value="${kind}"]`).isChecked(), true);
      assert.equal(await panel.locator("[data-native-all]").isChecked(), true);
      assert.equal(await panel.locator('[name="pf-knowledge-rule-all"]').isChecked(), false);
      await panel.locator('[name="pf-knowledge-rule-enabled"]').uncheck();
      const paused = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/knowledge/generation-policy") && response.request().method() === "PUT",
      );
      await panel.locator("[data-rule-apply]").click();
      assert.equal((await paused).status(), 200);
      assert.equal((await api("/api/knowledge/tasks/status?id=" + task.id)).task.state, "cancelled");
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        kind,
        scope: project === "personal" ? "personal" : "project",
        nativeRulesExplicitAndDocumentDefaultsPreserved: true,
        metadataSelectionAndScopePreview: true,
        searchPreservesOverrides: true,
        noBackfillUntilOriginalChanges: true,
        actualNativeTaskGenerated: true,
        typedOriginAndManualReview: true,
        ruleSurvivesReload: true,
        disablingCancelsUnadoptedTask: true,
        realExternalModelOrCallback: false,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/result.json", JSON.stringify({ passed: true, records }, null, 2) + "\n");
} finally {
  await app.dispose();
}
