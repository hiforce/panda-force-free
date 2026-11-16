import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const models = [
  { id: "model-catalog-one", model: "model-catalog-one", displayName: "Catalog One", isDefault: true },
  { id: "model-catalog-two", model: "model-catalog-two", displayName: "Catalog Two" },
].map((model) => ({
  ...model,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
}));
const fixture = await createAppFixture({ models });
const artifacts = process.env.PANDA_BOT_MODEL_ARTIFACTS || ".artifacts/bot-model-picker";
await mkdir(artifacts, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch();
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale,
      colorScheme: width === 1440 ? "light" : "dark",
    });
    let failModels = true;
    try {
      await fixture.signIn(context);
      await context.route("**/api/rpc", async (route) => {
        const payload = route.request().postDataJSON();
        if (payload.method === "model/list" && failModels) {
          await route.fulfill({ json: { type: "rpc/error", id: payload.id, error: "Fixture catalog unavailable" } });
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
        select = page.locator('select[name="pf-bot-model"]');
      await name.fill("Catalog Bot " + width);
      await page.locator('[name="pf-bot-code"]').fill("catalog-bot-" + width);
      await instructions.fill("Preserve these constraints while the catalog loads.");
      await page.locator("[data-bot-model-retry]").waitFor({ state: "visible" });
      assert.equal(await select.inputValue(), "");
      assert.equal(await select.locator("option").count(), 1);
      assert.equal(await name.inputValue(), "Catalog Bot " + width);
      assert.equal(await instructions.inputValue(), "Preserve these constraints while the catalog loads.");
      failModels = false;
      await page.locator("[data-bot-model-retry]").click();
      await select.locator('option[value="model-catalog-two"]').waitFor({ state: "attached" });
      assert.deepEqual(
        await select
          .locator("option")
          .evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent }))),
        [
          { value: "", label: locale === "en" ? "Engine default" : "跟随引擎默认模型" },
          { value: "model-catalog-one", label: "Catalog One" },
          { value: "model-catalog-two", label: "Catalog Two" },
        ],
      );
      const sessionModel = await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel);
      await select.selectOption("model-catalog-two");
      await page.locator("[data-bot-model-retry]").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), sessionModel);
      assert.equal(await instructions.inputValue(), "Preserve these constraints while the catalog loads.");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(artifacts, "models-" + width + ".png") });
      const save = page.waitForResponse(
        (response) => response.url().endsWith("/api/bots") && response.request().method() === "POST",
      );
      await page.locator('[data-create-bot] button[type="submit"]').click();
      const saved = await save;
      assert.equal(saved.status(), 201);
      const createdBot = (await saved.json()).bot;
      assert.equal(createdBot.model, "model-catalog-two");
      await page
        .locator(".bot-config-row strong")
        .getByText("Catalog Bot " + width, { exact: true })
        .waitFor();
      await page.locator("[data-new-bot]").click();
      await name.fill("Default Bot " + width);
      await page.locator('[name="pf-bot-code"]').fill("default-bot-" + width);
      await select.selectOption("");
      const defaultSave = page.waitForResponse(
        (response) => response.url().endsWith("/api/bots") && response.request().method() === "POST",
      );
      await page.locator('[data-create-bot] button[type="submit"]').click();
      const defaultSaved = await defaultSave;
      assert.equal(defaultSaved.status(), 201);
      assert.equal((await defaultSaved.json()).bot.model, "");
      await page.locator(`[data-edit="${createdBot.id}"]`).click();
      assert.equal(await name.inputValue(), "Catalog Bot " + width);
      assert.equal(await page.locator('[name="pf-bot-code"]').inputValue(), createdBot.code);
      assert.equal(await page.locator('[name="pf-bot-code"]').evaluate((element) => element.readOnly), true);
      assert.equal(await select.inputValue(), "model-catalog-two");
      await name.fill("Edited catalog bot " + width);
      await page.locator("dialog.bot-dialog[open] details.bot-form-section").evaluate((el) => {
        el.open = true;
      });
      const hosts = page.locator('[name="pf-bot-hosts"]');
      await hosts.fill("https://invalid.example.com");
      const invalidEdit = page.waitForResponse(
        (response) => response.url().endsWith("/api/bots/" + createdBot.id) && response.request().method() === "PATCH",
      );
      await page.locator('[data-create-bot] button[type="submit"]').click();
      assert.equal((await invalidEdit).status(), 400);
      await page
        .locator("[data-bot-dialog-notice]")
        .filter({ hasText: locale === "en" ? "failed" : "失败" })
        .waitFor();
      assert.equal(await name.inputValue(), "Edited catalog bot " + width);
      assert.equal(await hosts.inputValue(), "https://invalid.example.com");
      await hosts.fill("callback.example.com\nsecondary.example.com");
      await select.selectOption("model-catalog-one");
      await page.locator('[data-create-bot] button[type="submit"]').focus();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(artifacts, "edit-" + width + ".png"), fullPage: true });
      const editSave = page.waitForResponse(
        (response) => response.url().endsWith("/api/bots/" + createdBot.id) && response.request().method() === "PATCH",
      );
      await page.locator('[data-create-bot] button[type="submit"]').click();
      const editResponse = await editSave;
      assert.equal(editResponse.status(), 200);
      const updatedBot = (await editResponse.json()).bot;
      assert.deepEqual(updatedBot, {
        ...createdBot,
        name: "Edited catalog bot " + width,
        model: "model-catalog-one",
        callbackHosts: ["callback.example.com", "secondary.example.com"],
      });
      await page
        .locator("[data-bot-notice]")
        .filter({ hasText: locale === "en" ? "updated" : "更新" })
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
      await hosts.fill("unsaved.example.com");
      await page.locator("[data-cancel-edit]").click();
      await page.locator("[data-cancel-edit]").waitFor({ state: "detached" });
      const legacy = await context.request.post(fixture.base + "/api/bots", {
        data: { code: "legacy-model-" + width, name: "Legacy model bot", model: "retained-model", callbackHosts: [] },
      });
      const legacyBot = (await legacy.json()).bot;
      await page.locator("[data-refresh]").click();
      await page.locator(`[data-edit="${legacyBot.id}"]`).click();
      assert.equal(await select.inputValue(), "retained-model");
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
      assert.equal(bots.find((bot) => bot.code === "catalog-bot-" + width).model, "model-catalog-one");
      assert.deepEqual(bots.find((bot) => bot.id === createdBot.id).callbackHosts, [
        "callback.example.com",
        "secondary.example.com",
      ]);
      assert.equal(bots.find((bot) => bot.id === legacyBot.id).model, "retained-model");
      assert.equal(bots.find((bot) => bot.code === "default-bot-" + width).model, "");
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        sharedCatalogLabelsAndIds: true,
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
    JSON.stringify({ passed: true, records, modelTasksSubmitted: false }, null, 2) + "\n",
  );
} finally {
  await fixture.dispose();
}
