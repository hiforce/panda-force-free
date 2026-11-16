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
  out = ".artifacts/knowledge-native-sources";
await mkdir(out, { recursive: true });
try {
  const results = [];
  for (const [engine, width, locale, kind] of [
    [chromium, 1440, "en", "web"],
    [webkit, 390, "zh-CN", "slides"],
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
        const response = await context.request.fetch(app.base + path, { method, data, headers: { origin: app.base } });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api("/api/projects", {
          code: "native-knowledge-" + width,
          name: "Saved source knowledge",
          revision: catalog.revision,
        }),
        project =
          width < 700 ? { id: "personal" } : created.projects.find((item) => item.code === "native-knowledge-" + width),
        id = "c-" + randomUUID(),
        name = kind === "web" ? "guide.html" : "guide.pptx",
        imported = await context.request.post(
          app.base +
            "/api/creative-assets/import?" +
            new URLSearchParams({
              project: project.id,
              id,
              operationId: randomUUID(),
              kind,
              title: "Verified native source",
              locale: "en",
              name,
            }),
          {
            data:
              kind === "web"
                ? Buffer.from(
                    "<main><h1>Verified native source</h1><p>Durable sources preserve exact evidence.</p><script>Hidden script</script></main>",
                  )
                : Buffer.from(officeFixture({ slides: 2 }).bytes()),
            headers: { origin: app.base, "content-type": "application/octet-stream" },
          },
        );
      assert.equal(imported.status(), 201, await imported.text());
      const alternateKind = kind === "web" ? "slides" : "web",
        alternateId = "c-" + randomUUID();
      const alternateResponse = await context.request.post(
        app.base +
          "/api/creative-assets/import?" +
          new URLSearchParams({
            project: project.id,
            id: alternateId,
            operationId: randomUUID(),
            kind: alternateKind,
            title: "Supporting source",
            locale: "en",
            name: alternateKind === "web" ? "support.html" : "support.pptx",
          }),
        {
          data:
            alternateKind === "web"
              ? Buffer.from("<h1>Supporting facts</h1><p>Evidence has a saved source.</p>")
              : Buffer.from(officeFixture({ slides: 1 }).bytes()),
          headers: { origin: app.base, "content-type": "application/octet-stream" },
        },
      );
      assert.equal(alternateResponse.status(), 201, await alternateResponse.text());
      const asset = (await imported.json()).asset,
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      const assetUrl =
        app.base + "/project?" + new URLSearchParams({ id: project.id, asset: id, assetVersion: asset.version });
      await page.goto(assetUrl);
      await page.locator(".creative-asset-dialog[open] [data-asset-knowledge]").click();
      const panel = page.locator(".knowledge-panel[open]"),
        source = panel.locator(`input[name="pf-knowledge-source"][value="${id}"]`),
        selectKind = async (value) => {
          const response = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/content-sources" &&
              new URL(response.url()).searchParams.get("contentKinds") === value,
          );
          await panel.locator("[data-source-kind]").selectOption(value);
          assert.equal((await response).status(), 200);
          await waitFor(() => panel.locator("[data-knowledge-submit]").isEnabled());
        };
      await waitFor(() => panel.locator("[data-knowledge-submit]").isEnabled());
      assert.equal(await panel.locator("[data-source-kind]").inputValue(), kind);
      assert.equal(await source.isChecked(), true);
      await selectKind("document");
      await selectKind(alternateKind);
      await panel.locator(`input[name="pf-knowledge-source"][value="${alternateId}"]`).check();
      assert.match(await panel.locator("[data-source-summary]").innerText(), /2/);
      await panel.locator("[data-source-summary]").click();
      await panel.locator(`[data-source-remove="${alternateId}"]`).click();
      assert.match(await panel.locator("[data-source-summary]").innerText(), /1/);
      await panel.locator(`input[name="pf-knowledge-source"][value="${alternateId}"]`).check();
      await panel.locator("[data-source-summary]").click();
      await selectKind(kind);
      assert.equal(await source.isChecked(), true);
      await panel.locator("[data-knowledge-filter]").fill("nothing-matches");
      await panel.locator("[data-knowledge-sources] input").waitFor({ state: "detached" });
      assert.match(await panel.locator("[data-source-summary]").innerText(), /2/);
      await panel.locator("[data-knowledge-filter]").fill("");
      await source.waitFor();
      assert.equal(await source.isChecked(), true);
      await page.screenshot({ path: out + "/picker-" + width + ".png" });
      let initial, replay, submitted;
      await page.route("**/api/knowledge/tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const input = route.request().postDataJSON();
        if (!initial) {
          initial = input;
          const response = await route.fetch();
          assert.equal(response.status(), 202);
          submitted = await response.json();
          return route.abort("failed");
        }
        replay = input;
        return route.continue();
      });
      await panel.locator('[name="pf-knowledge-purpose"]').fill("Explain the saved original using exact evidence.");
      await panel.locator("[data-knowledge-submit]").click();
      await waitFor(
        async () => !!initial && !!submitted && (await panel.locator("[data-knowledge-submit]").isEnabled()),
      );
      assert.deepEqual(initial.contentKinds, ["slides", "web"]);
      assert.deepEqual(initial.ids, [id, alternateId].sort());
      assert.equal(await panel.locator("[data-source-kind]").isDisabled(), true);
      await panel.locator("[data-knowledge-close]").click();
      await page.reload();
      await page.locator(".creative-asset-dialog[open] [data-asset-knowledge]").click();
      await waitFor(() => panel.locator("[data-knowledge-submit]").isEnabled());
      assert.equal(await panel.locator("[data-source-kind]").isDisabled(), true);
      await panel.locator("[data-knowledge-submit]").click();
      await waitFor(async () => !!replay && (await panel.locator("[data-source-kind]").isEnabled()));
      assert.deepEqual(replay, initial);
      let task;
      await panel.locator('[data-knowledge-action="approve"]').waitFor();
      await panel.locator('[data-knowledge-action="approve"]').click();
      await waitFor(
        async () => {
          task = (await api("/api/knowledge/tasks/status?id=" + submitted.task.id)).task;
          return task.state === "completed";
        },
        { timeout: 20000 },
      );
      const history = await api("/api/knowledge/tasks?project=" + project.id);
      assert.equal(history.tasks.filter((row) => row.id === submitted.task.id).length, 1);
      assert.equal(history.tasks.length, 1);
      await panel.locator("[data-knowledge-close]").click();
      assert.equal(
        await page
          .locator(".creative-asset-dialog[open] [data-asset-knowledge]")
          .evaluate((element) => element === document.activeElement),
        true,
      );
      const value = await api(
        "/api/knowledge/records/detail?" + new URLSearchParams({ project: project.id, id: task.result.id }),
      );
      assert.equal(value.record.sources.find((row) => row.id === id).binding.kind, kind);
      assert.equal(value.record.sources.find((row) => row.id === alternateId).binding.kind, alternateKind);
      await page.goto(
        app.base + "/documents?" + new URLSearchParams({ project: project.id, knowledge: task.result.id }),
      );
      const dialog = page.locator(".knowledge-record[open]");
      await dialog.locator(".knowledge-claim").waitFor();
      const citation = dialog.locator(`.knowledge-record-sources a[href*="asset=${id}"]`),
        url = new URL(await citation.getAttribute("href"), app.base);
      assert.equal(url.pathname, project.id === "personal" ? "/create" : "/project");
      assert.equal(url.searchParams.get("asset"), id);
      assert.equal(url.searchParams.get("assetVersion"), asset.version);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
      assert.ok(
        await dialog
          .locator("[data-knowledge-close]")
          .evaluate((element) => element.getBoundingClientRect().height >= 44),
      );
      await page.screenshot({ path: out + "/approved-" + width + ".png" });
      await citation.click();
      await page.waitForURL(
        (url) => url.searchParams.get("asset") === id && url.searchParams.get("assetVersion") === asset.version,
      );
      const original = page.locator("dialog.creative-asset-dialog[open]");
      if (kind === "web") {
        await original.locator("[data-asset-frame]").waitFor();
        assert.equal(await original.locator("[data-asset-frame]").getAttribute("sandbox"), "");
      } else {
        await original.locator(".creative-asset-sections section").first().waitFor();
        assert.equal(await original.locator(".creative-asset-sections section").count(), 2);
        assert.match(await original.locator(".creative-asset-sections").innerText(), /Hello world/);
      }
      await page.screenshot({ path: out + "/original-" + width + ".png" });
      assert.deepEqual(errors, []);
      results.push({
        width,
        locale,
        kind,
        realNativeWorkflowAndApproval: true,
        manualEntryAndTypedPicker: true,
        contentScope: project.id === "personal" ? "personal" : "project",
        selectionAcrossKindsAndSearch: true,
        mixedNativeSubmissionAndSelectionRemoval: true,
        immutableSubmissionRetryAfterReload: true,
        noDuplicateTaskOnNetworkFailure: true,
        versionPinnedCitation: true,
        originalOpened: true,
        noHorizontalOverflow: true,
        realInferenceOrExternalCallback: false,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/result.json", JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await app.dispose();
}
