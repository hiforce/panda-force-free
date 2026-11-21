import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { openComposerSettings } from "../support/composer-settings.mjs";
const out = process.env.PANDA_RUNTIME_MODELS_ARTIFACTS || ".artifacts/runtime-model-selection";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  applicationCreation: true,
  applicationChat: true,
  models: [
    {
      id: "gpt-fixture",
      model: "gpt-fixture",
      displayName: "GPT fixture",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    },
  ],
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "grok-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome: account,
        },
      ]),
    };
  },
});
const records = [];
try {
  for (const locale of (process.env.PANDA_RUNTIME_MODELS_LOCALES || "en,zh-CN,zh-HK,zh-TW").split(","))
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height: 1000 },
          locale,
          isMobile: width < 768,
          hasTouch: width < 768,
          ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
        });
      const suffix = locale.toLowerCase() + "-" + width;
      let page;
      try {
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        await app.signIn(context);
        page = await context.newPage();
        page.setDefaultTimeout(20000);
        const navigate = async (path) => {
          await page.evaluate((path) => {
            history.pushState({}, "", path);
            dispatchEvent(new PopStateEvent("popstate"));
          }, path);
        };
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const api = async (path, body, method = "GET") => {
          const response = await context.request.fetch(app.base + path, {
            method,
            headers: { Origin: app.base },
            ...(body === undefined ? {} : { data: body }),
          });
          assert(response.ok(), path + ": " + response.status() + " " + (await response.text()));
          return response.json();
        };
        await page.goto(app.base + "/new");
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator("#prompt").fill("Preserve my draft across runtime settings.");
        await openComposerSettings(page, "model");
        const sessionSettings = page.locator("#sessionSettingsDialog");
        await sessionSettings
          .locator('[name="session-runtime-model"] option[value="gpt-fixture"]')
          .waitFor({ state: "attached" });
        await sessionSettings.locator('[name="session-runtime-runtime"]').selectOption("grok-local");
        await sessionSettings
          .locator('[name="session-runtime-model"] option[value="grok-fixture"]')
          .waitFor({ state: "attached" });
        assert.equal(await sessionSettings.locator('[name="session-runtime-model"]').inputValue(), "");
        await sessionSettings.locator('[name="session-runtime-model"]').selectOption("grok-fixture");
        await sessionSettings.locator('[name="session-runtime-effort"]').selectOption("low");
        await page.screenshot({ path: join(out, "session-settings-" + suffix + ".png"), fullPage: true });
        await sessionSettings.locator('[type="submit"]').click();
        await sessionSettings.waitFor({ state: "hidden" });
        assert.equal(await page.locator("#prompt").inputValue(), "Preserve my draft across runtime settings.");
        assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "grok-fixture");
        await openComposerSettings(page, "model");
        await sessionSettings.locator('[name="session-runtime-runtime"]').selectOption("codex");
        await sessionSettings
          .locator('[name="session-runtime-model"] option[value="gpt-fixture"]')
          .waitFor({ state: "attached" });
        assert.equal(await sessionSettings.locator('[name="session-runtime-effort"]').inputValue(), "");
        await sessionSettings.locator('[type="submit"]').click();
        await sessionSettings.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-fixture");
        assert.equal(
          await page.evaluate(() => globalThis.__pandaForceDebug.state.models.some((m) => m.model === "grok-fixture")),
          false,
        );
        await navigate("/settings/bots");
        await page.locator("[data-new-bot]").click();
        await page.locator('[name="pf-bot-name"]').fill("Runtime bot " + suffix);
        await page.locator('[name="pf-bot-code"]').fill("runtime-" + suffix);
        const runtime = page.locator('[name="pf-bot-runtime"]'),
          model = page.locator('[name="pf-bot-model"]'),
          effort = page.locator('[name="pf-bot-effort"]');
        await runtime.locator('option[value="grok-local"]').waitFor({ state: "attached" });
        await runtime.selectOption("grok-local");
        await model.locator('option[value="grok-fixture"]').waitFor({ state: "attached" });
        assert.deepEqual(await model.locator("option").evaluateAll((nodes) => nodes.map((n) => n.value)), [
          "",
          "grok-fixture",
        ]);
        await model.selectOption("grok-fixture");
        await effort.selectOption("low");
        const beforeModel = await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel);
        await page.screenshot({ path: join(out, "bot-" + suffix + ".png"), fullPage: true });
        const saved = page.waitForResponse((r) => r.url().endsWith("/api/bots") && r.request().method() === "POST");
        await page.locator('[data-create-bot] [type="submit"]').click();
        const response = await saved;
        assert.equal(response.status(), 201, await response.text());
        const bot = (await response.json()).bot;
        assert.equal(bot.runtimeId, "grok-local");
        assert.equal(bot.model, "grok-fixture");
        assert.equal(bot.effort, "low");
        assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), beforeModel);
        await page.locator(`[data-edit="${bot.id}"]`).click();
        await model.locator('option[value="grok-fixture"]').waitFor({ state: "attached" });
        assert.equal(await runtime.inputValue(), "grok-local");
        assert.equal(await effort.inputValue(), "low");
        await runtime.selectOption("codex");
        await model.locator('option[value="gpt-fixture"]').waitFor({ state: "attached" });
        assert.equal(await model.inputValue(), "");
        assert.equal(await effort.inputValue(), "");
        await page.locator("[data-cancel-edit]").click();
        const invalid = await context.request.patch(app.base + "/api/bots/" + bot.id, {
          headers: { Origin: app.base },
          data: { runtimeId: "grok-local", model: "gpt-fixture" },
        });
        assert.equal(invalid.status(), 409);
        assert.equal((await api("/api/bots/" + bot.id)).bot.model, "grok-fixture");
        await api(
          "/api/bots/" + bot.id + "/chat",
          { requestId: crypto.randomUUID(), generation: 1, text: "My project is a blue panda." },
          "POST",
        );
        await waitFor(async () => !(await api("/api/bots/" + bot.id + "/chat")).busy);
        assert.match((await api("/api/bots/" + bot.id + "/chat")).messages.at(-1).text, /grok-fixture low/);
        // The full creation dialogue uses the same component and keeps native session preferences independent.
        await navigate("/create");
        await page.locator(".creation-entry-composer #composer").waitFor();
        await openComposerSettings(page, "model");
        const setting = page.locator("#sessionSettingsDialog[open]");
        await setting
          .locator('[name="session-runtime-runtime"] option[value="grok-local"]')
          .waitFor({ state: "attached" });
        await setting.locator('[name="session-runtime-runtime"]').selectOption("grok-local");
        await setting
          .locator('[name="session-runtime-model"] option[value="grok-fixture"]')
          .waitFor({ state: "attached" });
        await setting.locator('[name="session-runtime-model"]').selectOption("grok-fixture");
        await setting.locator('[name="session-runtime-effort"]').selectOption("low");
        await page.screenshot({ path: join(out, "creation-settings-" + suffix + ".png"), fullPage: true });
        await setting.locator('[type="submit"]').click();
        await setting.waitFor({ state: "hidden" });
        await page.locator("#prompt").fill("Write a document about a blue panda.");
        const creationSaved = page.waitForResponse(
          (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
        );
        await page.locator("#sendButton").click();
        const creationResponse = await creationSaved;
        assert.equal(creationResponse.status(), 202, await creationResponse.text());
        const task = (await creationResponse.json()).task;
        assert.equal(task.runtimeId, "grok-local");
        assert.equal(task.model, "grok-fixture");
        assert.equal(task.effort, "low");
        const taskPath = "/api/personal/document-creations/detail?id=" + task.id;
        await waitFor(async () => ["succeeded", "failed"].includes((await api(taskPath)).task.state), 30000);
        const completed = (await api(taskPath)).task;
        assert.equal(completed.state, "succeeded", JSON.stringify(completed));
        await page.screenshot({ path: join(out, "creation-result-" + suffix + ".png"), fullPage: true });
        // A project creation form shares runtime/model/effort selection and its saved draft.
        const projects = await api("/api/projects");
        const project = await api(
          "/api/projects",
          {
            code: "runtime-project-" + suffix,
            name: "Runtime project",
            revision: projects.revision,
            operationId: crypto.randomUUID(),
          },
          "POST",
        );
        const projectId = project.projects.find((p) => p.code === "runtime-project-" + suffix).id;
        await navigate("/documents?project=" + projectId);
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator('[data-authoring-action="new-ai"]:visible').first().click();
        const panel = page.locator("#projectDocumentCreation");
        await panel.locator('[name="creation-runtime"] option[value="grok-local"]').waitFor({ state: "attached" });
        await panel.locator('[name="creation-runtime"]').selectOption("grok-local");
        await panel.locator('[name="creation-model"] option[value="grok-fixture"]').waitFor({ state: "attached" });
        await panel.locator('[name="creation-model"]').selectOption("grok-fixture");
        await panel.locator('[name="creation-effort"]').selectOption("low");
        await panel.locator('[name="prompt"]').fill("This are a test.");
        await page.screenshot({ path: join(out, "project-" + suffix + ".png"), fullPage: true });
        await panel.locator("[data-creation-close]").click();
        await page.locator('[data-authoring-action="new-ai"]:visible').first().click();
        await panel.locator('[name="creation-model"] option[value="grok-fixture"]').waitFor({ state: "attached" });
        assert.equal(await panel.locator('[name="creation-runtime"]').inputValue(), "grok-local");
        assert.equal(await panel.locator('[name="creation-effort"]').inputValue(), "low");
        await panel.locator("[data-creation-close]").click();
        const reviewProjects = await app.legacyProject({ code: "review-" + suffix, name: "Review project" });
        const reviewProjectId = reviewProjects.projects.find((p) => p.code === "review-" + suffix).id;
        const source = await api(
          "/api/project-documents",
          { projectId: reviewProjectId, title: "Review source", locale: "en" },
          "POST",
        );
        const savedDocument = await api(
          "/api/documents/detail?id=" + source.document.id,
          {
            revision: 1,
            title: "Review source",
            locale: "en",
            body: {
              schema: 1,
              format: "richtext",
              document: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "This are a test." }] }],
              },
            },
          },
          "PUT",
        );
        await navigate("/documents?project=" + reviewProjectId + "&document=" + source.document.id);
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator(".document-rich-content").waitFor();
        await page.locator('[data-doc-action="publishing"]').click();
        await page.locator('#documentPublicationDialog [data-placement-action="spacing"]:not([disabled])').click();
        const review = page.locator("#editorialDialog");
        await review.locator("#editorialProcessor option[value=__harness_runtime__]").waitFor({ state: "attached" });
        await review.locator(".editorial-model-controls summary").click();
        await review.locator('[name="editorial-runtime"] option[value="grok-local"]').waitFor({ state: "attached" });
        await review.locator('[name="editorial-runtime"]').selectOption("grok-local");
        await review.locator('[name="editorial-model"] option[value="grok-fixture"]').waitFor({ state: "attached" });
        await review.locator('[name="editorial-model"]').selectOption("grok-fixture");
        await review.locator('[name="editorial-effort"]').selectOption("low");
        await review.locator('[data-editorial-action="model-submit"]:enabled').click();
        await review.locator('[data-editorial-state="succeeded"]').waitFor();
        await review.locator('[data-editorial-action="model-view"]').click();
        await review.locator("[data-editorial-edit]").waitFor();
        const unchangedDocument = await api("/api/documents/detail?id=" + source.document.id);
        assert.equal(unchangedDocument.revision.id, savedDocument.revision.id);
        assert.match(JSON.stringify(unchangedDocument.revision.body), /This are a test/);
        await page.screenshot({ path: join(out, "editorial-" + suffix + ".png"), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        records.push({ locale, width, passed: true });
      } catch (error) {
        if (page) {
          await page.screenshot({ path: join(out, "failure-" + suffix + ".png"), fullPage: true });
          await writeFile(
            join(out, "failure-" + suffix + ".txt"),
            String(error) + "\n" + (await page.locator("body").innerText()),
          );
        }
        throw error;
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(join(out, "result.json"), JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: records.length }));
} finally {
  await app.dispose();
}
