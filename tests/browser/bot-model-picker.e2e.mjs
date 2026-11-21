import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const models = [
  { id: "model-catalog-one", model: "model-catalog-one", displayName: "Catalog One", isDefault: true },
  { id: "model-catalog-two", model: "model-catalog-two", displayName: "Catalog Two" },
].map((model) => ({
  ...model,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: (model.id.endsWith("one") ? ["medium", "high", "xhigh"] : ["low", "medium"]).map(
    (reasoningEffort) => ({ reasoningEffort }),
  ),
}));
const fixture = await createAppFixture({ models, applicationChat: true, startupTimeoutMs: 60000 });
const artifacts = process.env.PANDA_BOT_MODEL_ARTIFACTS || ".artifacts/bot-model-picker";
await mkdir(artifacts, { recursive: true });
const records = [];
try {
  for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"])
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const suffix = width + "-" + locale.toLowerCase();
      const browser = await engine.launch();
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
        colorScheme: width === 1440 ? "light" : "dark",
      });
      let failModels = true;
      try {
        await fixture.signIn(context);
        await context.route("**/api/model-catalog?runtimeId=*", async (route) => {
          if (failModels) {
            await route.fulfill({ status: 503, json: { error: "Fixture catalog unavailable" } });
          } else await route.continue();
        });
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(15000);
        await page.goto(fixture.base + "/settings/bots");
        await page.locator("[data-new-bot]").click();
        const name = page.locator('[name="pf-bot-name"]'),
          instructions = page.locator('[name="pf-bot-instructions"]'),
          select = page.locator('select[name="pf-bot-model"]'),
          effort = page.locator('select[name="pf-bot-effort"]');
        await name.fill("Catalog Bot " + suffix);
        await page.locator('[name="pf-bot-code"]').fill("catalog-bot-" + suffix);
        await instructions.fill("Preserve these constraints while the catalog loads.");
        await page.locator("[data-bot-model-retry]").waitFor({ state: "visible" });
        assert.equal(await select.inputValue(), "");
        assert.equal(await select.locator("option").count(), 1);
        assert.equal(await name.inputValue(), "Catalog Bot " + suffix);
        assert.equal(await instructions.inputValue(), "Preserve these constraints while the catalog loads.");
        failModels = false;
        await page.locator("[data-bot-model-retry]").click();
        await select.locator('option[value="model-catalog-two"]').waitFor({ state: "attached" });
        assert.deepEqual(
          await select
            .locator("option")
            .evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent }))),
          [
            {
              value: "",
              label: {
                en: "Use runtime default",
                "zh-CN": "使用实例默认值",
                "zh-HK": "使用執行個體預設值",
                "zh-TW": "使用執行個體預設值",
              }[locale],
            },
            { value: "model-catalog-one", label: "Catalog One" },
            { value: "model-catalog-two", label: "Catalog Two" },
          ],
        );
        const sessionModel = await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel);
        await select.selectOption("model-catalog-two");
        assert.deepEqual(await effort.locator("option").evaluateAll((options) => options.map((o) => o.value)), [
          "",
          "low",
          "medium",
        ]);
        await effort.selectOption("low");
        await page.evaluate(async (locale) => {
          const runtime = globalThis[Symbol.for("PandaForce.browserI18n")];
          await runtime.setPreference(locale === "en" ? "zh-HK" : "en");
        }, locale);
        assert.equal(await effort.inputValue(), "low");
        assert.equal(await name.inputValue(), "Catalog Bot " + suffix);
        await page.evaluate(
          async (locale) => globalThis[Symbol.for("PandaForce.browserI18n")].setPreference(locale),
          locale,
        );

        await page.locator("[data-bot-model-retry]").waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), sessionModel);
        assert.equal(await instructions.inputValue(), "Preserve these constraints while the catalog loads.");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(artifacts, "models-" + suffix + ".png") });
        const save = page.waitForResponse(
          (response) => response.url().endsWith("/api/bots") && response.request().method() === "POST",
        );
        await page.locator('[data-create-bot] button[type="submit"]').click();
        const saved = await save;
        assert.equal(saved.status(), 201);
        const createdBot = (await saved.json()).bot;
        assert.equal(createdBot.model, "model-catalog-two");
        assert.equal(createdBot.effort, "low");
        const callsBefore = fixture.calls().length;
        const sent = await context.request.post(fixture.base + "/api/bots/" + createdBot.id + "/chat", {
          headers: { Origin: fixture.base },
          data: { requestId: crypto.randomUUID(), generation: 1, text: "Check the saved model settings." },
        });
        assert.equal(sent.status(), 202);
        await waitFor(
          async () =>
            !(await (await context.request.get(fixture.base + "/api/bots/" + createdBot.id + "/chat")).json()).busy,
        );
        const calls = fixture.calls().slice(callsBefore);
        assert.equal(calls.find((c) => c.method === "thread/start")?.params.model, "model-catalog-two");
        assert.equal(calls.find((c) => c.method === "turn/start")?.params.effort, "low");

        await page
          .locator(".bot-config-row strong")
          .getByText("Catalog Bot " + suffix, { exact: true })
          .waitFor();
        await page.locator("[data-new-bot]").click();
        await name.fill("Default Bot " + width);
        await page.locator('[name="pf-bot-code"]').fill("default-bot-" + suffix);
        await select.selectOption("");
        const defaultSave = page.waitForResponse(
          (response) => response.url().endsWith("/api/bots") && response.request().method() === "POST",
        );
        await page.locator('[data-create-bot] button[type="submit"]').click();
        const defaultSaved = await defaultSave;
        assert.equal(defaultSaved.status(), 201);
        const defaultBot = (await defaultSaved.json()).bot;
        assert.equal(defaultBot.model, "");
        assert.equal(defaultBot.effort, "");
        await page.locator(`[data-edit="${createdBot.id}"]`).click();
        assert.equal(await name.inputValue(), "Catalog Bot " + suffix);
        assert.equal(await page.locator('[name="pf-bot-code"]').inputValue(), createdBot.code);
        assert.equal(await page.locator('[name="pf-bot-code"]').evaluate((element) => element.readOnly), true);
        assert.equal(await select.inputValue(), "model-catalog-two");
        assert.equal(await effort.inputValue(), "low");
        await name.fill("Edited catalog bot " + suffix);
        await page.locator("dialog.bot-dialog[open] details.bot-form-section").evaluate((el) => {
          el.open = true;
        });
        const hosts = page.locator('[name="pf-bot-hosts"]');
        await hosts.fill("https://invalid.example.com");
        const invalidEdit = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/bots/" + createdBot.id) && response.request().method() === "PATCH",
        );
        await page.locator('[data-create-bot] button[type="submit"]').click();
        assert.equal((await invalidEdit).status(), 400);
        await page
          .locator("[data-bot-dialog-notice]")
          .filter({ hasText: { en: "failed", "zh-CN": "失败", "zh-HK": "失敗", "zh-TW": "失敗" }[locale] })
          .waitFor();
        assert.equal(await name.inputValue(), "Edited catalog bot " + suffix);
        assert.equal(await hosts.inputValue(), "https://invalid.example.com");
        assert.equal(await effort.inputValue(), "low");
        await hosts.fill("callback.example.com\nsecondary.example.com");
        await select.selectOption("model-catalog-one");
        assert.equal(await effort.inputValue(), "");
        await effort.selectOption("xhigh");
        await page.locator('[data-create-bot] button[type="submit"]').focus();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(artifacts, "edit-" + suffix + ".png"), fullPage: true });
        const editSave = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/bots/" + createdBot.id) && response.request().method() === "PATCH",
        );
        await page.locator('[data-create-bot] button[type="submit"]').click();
        const editResponse = await editSave;
        assert.equal(editResponse.status(), 200);
        const updatedBot = (await editResponse.json()).bot;
        assert.deepEqual(updatedBot, {
          ...createdBot,
          name: "Edited catalog bot " + suffix,
          model: "model-catalog-one",
          effort: "xhigh",
          callbackHosts: ["callback.example.com", "secondary.example.com"],
        });
        await page
          .locator("[data-bot-notice]")
          .filter({ hasText: { en: "updated", "zh-CN": "更新", "zh-HK": "更新", "zh-TW": "更新" }[locale] })
          .waitFor()
          .catch(async (error) => {
            await page.screenshot({ path: join(artifacts, "saved-feedback-failure-" + width + ".png") });
            await writeFile(
              join(artifacts, "saved-feedback-failure-" + width + ".json"),
              JSON.stringify(
                await page.evaluate(() => ({
                  path: location.pathname,
                  settings: document.querySelector("#settingsDialog").open,
                  notices: [...document.querySelectorAll("[data-bot-notice],[data-bot-dialog-notice]")].map((el) => ({
                    text: el.textContent,
                    hidden: el.hidden,
                    display: getComputedStyle(el).display,
                  })),
                  dialogs: [...document.querySelectorAll("dialog[open]")].map((el) => el.className),
                })),
                null,
                2,
              ),
            );
            throw error;
          });
        await page.locator(`[data-edit="${createdBot.id}"]`).click();
        assert.equal(await hosts.inputValue(), "callback.example.com\nsecondary.example.com");
        assert.equal(await effort.inputValue(), "xhigh");
        await effort.selectOption("high");
        await hosts.fill("unsaved.example.com");
        await page.locator("[data-cancel-edit]").click();
        await page.locator("[data-cancel-edit]").waitFor({ state: "detached" });
        const legacy = await context.request.post(fixture.base + "/api/bots", {
          headers: { Origin: fixture.base },
          data: {
            code: "legacy-model-" + suffix,
            name: "Legacy model bot",
            model: "retained-model",
            effort: "retained-effort",
            callbackHosts: [],
          },
        });
        assert.equal(legacy.status(), 201, await legacy.text());
        const legacyBot = (await legacy.json()).bot;
        await page.locator("[data-refresh]").click();
        await page.locator(`[data-edit="${legacyBot.id}"]`).click();
        assert.equal(await select.inputValue(), "retained-model");
        assert.equal(await effort.inputValue(), "retained-effort");
        await page.locator("dialog.bot-dialog[open] details.bot-form-section").evaluate((el) => {
          el.open = true;
        });
        await hosts.fill("legacy.example.com");
        const legacySave = page.waitForResponse(
          (response) => response.url().endsWith("/api/bots/" + legacyBot.id) && response.request().method() === "PATCH",
        );
        await page.locator('[data-create-bot] button[type="submit"]').click();
        assert.equal((await legacySave).status(), 200);
        await page.reload();
        await page.locator("[data-bot-content]").waitFor();
        const bots = (await (await context.request.get(fixture.base + "/api/bots")).json()).bots;
        assert.equal(bots.find((bot) => bot.code === "catalog-bot-" + suffix).model, "model-catalog-one");
        assert.deepEqual(bots.find((bot) => bot.id === createdBot.id).callbackHosts, [
          "callback.example.com",
          "secondary.example.com",
        ]);
        assert.equal(bots.find((bot) => bot.id === legacyBot.id).model, "retained-model");
        assert.equal(bots.find((bot) => bot.id === legacyBot.id).effort, "retained-effort");
        assert.equal(bots.find((bot) => bot.id === createdBot.id).effort, "xhigh");
        assert.equal(bots.find((bot) => bot.code === "default-bot-" + suffix).model, "");
        assert.deepEqual(errors, []);
        records.push({
          width,
          locale,
          sharedCatalogLabelsAndIds: true,
          reasoningEffortPersistsAndFollowsModelCapabilities: true,
          failureAndRetryPreserveForm: true,
          botChoiceDoesNotChangeSession: true,
          explicitAndDefaultModelsPersist: true,
          editPersistsCallbackHostsAndModel: true,
          invalidEditPreservesBufferAndCancelDiscards: true,
          unavailableStoredModelCanBeRetained: true,
        });
      } finally {
        await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: "wait" })));
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
        await browser.close();
      }
    }
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      { passed: true, records, isolatedNativeProtocolVerified: true, externalModelCalls: false },
      null,
      2,
    ) + "\n",
  );
} finally {
  await fixture.dispose();
}
