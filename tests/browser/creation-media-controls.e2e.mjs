import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { apiMediaPresets } from "../../src/server/creation/integration/media-executors/presets.ts";
import { createAppFixture } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_CREATION_MEDIA_PROOF || ".artifacts/creation-media-executors/browser";
await mkdir(proof, { recursive: true });
const stateDirectory = process.env.PANDA_CREATION_MEDIA_TEST_STATE
  ? await mkdtemp(join(process.env.PANDA_CREATION_MEDIA_TEST_STATE, "panda-creation-media-"))
  : null;
let app;
try {
  app = await createAppFixture({
    applicationCreation: true,
    startupTimeoutMs: 120000,
    prepareState: async ({ stateRoot }) => {
      if (stateDirectory) await symlink(stateDirectory, stateRoot, "dir");
    },
  });
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1190, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 768,
        colorScheme: locale === "zh-CN" || locale === "zh-HK" ? "dark" : "light",
        locale,
      });
      await context.addInitScript((language) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", language);
      }, locale);
      await app.signIn(context);
      const page = await context.newPage();
      const activate = (control) => (width < 768 ? control.tap() : control.click());
      page.setDefaultTimeout(20000);
      const preset = {
        id: "grok-image",
        version: 1,
        name: "Grok Image",
        provider: "xai",
        kind: "image",
        models: [{ id: "fixture-image-model", name: "Fixture model" }],
      };
      const apiPresets = [
        preset,
        {
          id: "openai-image",
          name: "OpenAI Image",
          kind: "image",
          provider: "openai",
          version: 1,
          models: [
            { id: "openai-quality", name: "Quality model" },
            { id: "openai-fast", name: "Fast model" },
          ],
        },
        {
          id: "openai-audio",
          name: "OpenAI Audio",
          kind: "audio",
          provider: "openai",
          version: 1,
          models: [{ id: "audio-model", name: "Audio model" }],
        },
        ...apiMediaPresets.filter((item) => item.kind === "image" && !["openai", "xai"].includes(item.provider)),
      ];
      const executors = [];
      const credentials = [];
      let slowConnection = false;
      let connectionAttempts = 0;
      let workerConfigured = true,
        mayManageCli = true;
      let cliRegistered = false,
        cliPosts = 0;
      const cli = {
        id: "cli-browser-fixture",
        name: "Reference CLI",
        version: "1.0.0",
        revision: 1,
        kind: "image",
        sha256: "1".repeat(64),
        fingerprint: "2".repeat(64),
      };
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/personal/creation-media-cli**", async (route) => {
        const request = route.request();
        if (!mayManageCli) return route.fulfill({ status: 403, json: { code: "forbidden" } });
        if (!workerConfigured) return route.fulfill({ json: { configured: false, packages: [] } });
        if (request.method() === "POST") {
          assert.deepEqual(request.postDataJSON(), { id: cli.id, revision: 1, fingerprint: cli.fingerprint });
          if (++cliPosts === 1) {
            await Bun.sleep(500);
            return route.fulfill({ status: 503, json: { code: "unavailable" } });
          }
          cliRegistered = true;
          return route.fulfill({ json: { registered: true } });
        }
        if (new URL(request.url()).search)
          return route.fulfill({ json: { install: "Verify the executable.", usage: "<b>Submit and download.</b>" } });
        return route.fulfill({ json: { configured: true, packages: [{ ...cli, registered: cliRegistered }] } });
      });
      await page.route("**/api/personal/creation-media-credentials", async (route) => {
        const { id, target, name, apiKey, revision } = route.request().postDataJSON();
        const index = credentials.findIndex((item) => item.id === id);
        if (route.request().method() === "DELETE") {
          assert(index >= 0);
          assert.equal(credentials[index].revision, revision);
          credentials.splice(index, 1);
          for (const item of executors.filter((item) => item.credentialId === id)) item.credentialUnavailable = true;
          return route.fulfill({ json: { removed: true } });
        }
        assert.equal(apiKey, index < 0 ? "fixture-browser-key" : "fixture-rotated-key");
        assert.equal(revision, index < 0 ? 0 : credentials[index].revision);
        const saved = { id, name, target, revision: revision + 1 };
        if (index < 0) credentials.push(saved);
        else credentials[index] = saved;
        return route.fulfill({ json: saved });
      });
      await page.route("**/api/personal/creation-media-executors", async (route) => {
        if (!workerConfigured) return route.fulfill({ json: { configured: false, presets: [], executors: [] } });
        if (route.request().method() === "POST") {
          const input = route.request().postDataJSON();
          const selected = apiPresets.find((entry) => entry.id === input.preset);
          assert(selected?.models.some((model) => model.id === input.model));
          assert(!Object.hasOwn(input, "apiKey"));
          assert(
            credentials.some(
              (item) => item.id === input.credentialId && item.target === (selected.provider ?? selected.id),
            ),
          );
          if (slowConnection && ++connectionAttempts === 1) {
            await Bun.sleep(450);
            return route.fulfill({ status: 429, json: { code: "rateLimited" } });
          }
          const executor = {
            id: input.id,
            name: input.name || selected.name,
            preset: selected.id,
            model: input.model,
            presetVersion: 1,
            kind: selected.kind,
            revision: 1,
            status: "connected",
            credentialId: input.credentialId,
          };
          executors.push(executor);
          return route.fulfill({ json: executor });
        }
        if (route.request().method() === "DELETE") {
          const { id, revision } = route.request().postDataJSON();
          const index = executors.findIndex((item) => item.id === id && item.revision === revision);
          assert(index >= 0);
          executors.splice(index, 1);
          return route.fulfill({ json: { removed: true } });
        }
        const presets = [...apiPresets];
        if (cliRegistered)
          presets.push({
            id: cli.id,
            name: cli.name,
            version: 1,
            kind: cli.kind,
            transport: "cli",
            models: [{ id: "cli-model", name: "CLI model" }],
          });
        return route.fulfill({ json: { presets, executors, credentials } });
      });
      const messages = JSON.parse(
        await readFile(new URL(`../../src/shared/i18n/locales/${locale}/creation.json`, import.meta.url), "utf8"),
      );
      const settings = page.locator('[data-settings-content="media-executors"]');
      const add = settings.locator("[data-executor-add]");
      const dialog = page.locator('dialog[aria-labelledby="executor-dialog-title"][open]');
      const credentialDialog = page.locator('dialog[aria-labelledby="executor-credential-title"][open]');
      const credentialSettings = page.locator('[data-settings-content="media-credentials"]');
      const credentialField = dialog.locator('select[name="credentialId"]');
      async function saveCredential(name, target, key = "fixture-browser-key") {
        await credentialDialog.waitFor();
        const field = credentialDialog.locator("summary.executor-picker-trigger");
        if (target) {
          await activate(field);
          await activate(credentialDialog.locator(`button[data-value="${target}"]`));
        }
        assert.equal(await credentialDialog.locator('[name="credentialKey"]').inputValue(), "");
        await credentialDialog.locator('[name="credentialName"]').fill(name);
        await credentialDialog.locator('[name="credentialKey"]').fill(key);
        await activate(credentialDialog.locator('[type="submit"]'));
        await credentialDialog.waitFor({ state: "hidden" });
      }
      const provider = dialog.locator('[name="provider"]');
      const providerPicker = dialog.locator("[data-executor-provider-field] .executor-picker");
      const providerTrigger = providerPicker.locator("summary");
      const model = dialog.locator('[name="model"]');
      const submit = dialog.locator('[type="submit"]');
      const category = (kind) => dialog.locator(`label:has(input[value="${kind}"])`);
      await page.goto(app.base + "/settings/media-credentials");
      await credentialSettings.getByRole("heading", { name: messages.credentialEmpty, exact: true }).waitFor();
      for (const name of ["Studio", "Backup"]) {
        await activate(credentialSettings.locator("[data-credential-add]"));
        await saveCredential(name, "openai");
      }
      const preferredCredential = credentials[0].id;
      await page.screenshot({ path: join(proof, `credentials-${locale}-${width}.png`) });
      await page.goto(app.base + "/settings/media-executors");
      await settings
        .getByRole("heading", { name: messages.mediaSettings, exact: true })
        .waitFor()
        .catch(async (error) => {
          console.error("Settings startup", page.url(), errors, await page.locator("h1:visible").allTextContents());
          await page.screenshot({ path: join(proof, `startup-failed-${locale}-${width}.png`) });
          throw error;
        });
      await settings.getByRole("heading", { name: messages.mediaEmpty, exact: true }).waitFor();
      assert.equal(await settings.locator(".executor-filters").getAttribute("aria-label"), messages.executorCategory);
      await page.waitForFunction(
        (dark) => document.documentElement.style.colorScheme === (dark ? "dark" : "light"),
        locale === "zh-CN" || locale === "zh-HK",
      );
      await page.screenshot({ path: join(proof, `empty-${locale}-${width}.png`) });
      await add.click();
      assert.equal(await dialog.locator('[name="category"]').count(), 5);
      assert(await category("image").locator("input").isChecked());
      assert(await providerTrigger.isVisible());
      assert(await model.isEnabled());
      assert.equal(await provider.inputValue(), "openai");
      assert.deepEqual(await model.locator("option").evaluateAll((options) => options.map((option) => option.value)), [
        "",
        "openai-quality",
        "openai-fast",
      ]);
      await page.screenshot({ path: join(proof, `default-${locale}-${width}.png`) });
      await activate(providerTrigger);
      for (const value of [
        "google",
        "stability",
        "black-forest-labs",
        "volcengine",
        "recraft",
        "ideogram",
        "alibaba-cloud",
        "fal",
      ]) {
        assert(
          await providerPicker.locator(`button[data-value="${value}"] [data-executor-brand="${value}"]`).isVisible(),
        );
      }
      assert(await providerPicker.locator('button[data-value="midjourney"]').isDisabled());
      await page.screenshot({ path: join(proof, `providers-${locale}-${width}.png`) });
      const stabilityChoice = providerPicker.locator('button[data-value="stability"]');
      if (width < 768) {
        await providerTrigger.focus();
        await stabilityChoice.evaluate((button) => {
          // Exercise the focus shift that can happen before a touch click is dispatched.
          button.addEventListener(
            "pointerdown",
            () => {
              button.closest("form").querySelector("[data-media-dismiss]").focus({ preventScroll: true });
            },
            { once: true },
          );
        });
      }
      await activate(stabilityChoice);
      assert.equal(await provider.inputValue(), "stability");
      assert(await providerTrigger.locator('[data-executor-brand="stability"]').isVisible());
      assert((await model.locator("option").allTextContents()).includes("Stable Image Ultra"));
      assert(!(await model.locator("option").allTextContents()).includes("Fast model"));
      await model.selectOption("ultra");
      await activate(providerTrigger);
      await activate(dialog.locator("h2"));
      await providerPicker.locator(".executor-picker-options").waitFor({ state: "hidden" });
      assert.equal(await provider.inputValue(), "stability");
      assert.equal(await model.inputValue(), "ultra");
      assert(await credentialField.isDisabled());
      await activate(dialog.locator("[data-add-credential]"));
      await saveCredential("Art studio");
      assert.equal(await credentialField.inputValue(), credentials.at(-1).id);
      assert.equal(await model.inputValue(), "ultra");
      await page.screenshot({ path: join(proof, `supplier-selected-${locale}-${width}.png`) });
      await providerTrigger.focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-value")), "xai");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(await provider.inputValue(), "openai");
      await providerTrigger.focus();
      await page.keyboard.press("End");
      await page.keyboard.press("Tab");
      await providerPicker.locator(".executor-picker-options").waitFor({ state: "hidden" });
      await model.selectOption("openai-fast");
      await page.screenshot({ path: join(proof, `add-${locale}-${width}.png`) });
      await credentialField.selectOption(preferredCredential);
      slowConnection = true;
      await submit.click();
      await dialog.getByText(messages.mediaChecking, { exact: true }).waitFor();
      assert(await submit.isDisabled());
      await dialog.getByText(messages.mediaRateLimited, { exact: true }).waitFor();
      assert.equal(await model.inputValue(), "openai-fast");
      assert.equal(await credentialField.inputValue(), preferredCredential);
      await submit.click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(connectionAttempts, 2);
      assert.equal(executors[0].model, "openai-fast");
      await settings.getByText(/Fast model/).waitFor();
      assert(await settings.locator('.executor-row [data-executor-brand="openai"]').isVisible());
      await page.screenshot({ path: join(proof, `list-${locale}-${width}.png`) });
      slowConnection = false;
      const edit = settings.locator(`button[data-media-configure="${executors[0].id}"]`);
      await edit.click();
      await dialog.waitFor();
      assert.equal(await credentialField.inputValue(), preferredCredential);
      assert.equal(await dialog.locator('input[type="password"]').count(), 0);
      assert.equal(await model.inputValue(), "openai-fast");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });

      await page.goto(app.base + "/create");
      const draft = "Create an illustrated short history of Greece.";
      await page.locator("#prompt").fill(draft);
      const output = page.locator("[data-creation-output]");
      const source = page.locator("[data-media-executor]");
      await output.selectOption("slides");
      await page.getByText(messages.mediaNativeUnverified, { exact: true }).waitFor();
      assert.equal(await source.locator('option[value="harness"]').count(), 0);
      assert.equal(await source.inputValue(), "");
      const sourcePicker = page.locator("[data-media-executor-field] .executor-picker");
      await activate(sourcePicker.locator("summary"));
      assert(
        await sourcePicker
          .locator(`button[data-value="${executors[0].id}"] [data-executor-brand="openai"]`)
          .isVisible(),
      );
      await page.screenshot({ path: join(proof, `creation-picker-${locale}-${width}.png`) });
      await page.keyboard.press("Escape");
      await page.locator("[data-media-add]").click();
      await activate(providerTrigger);
      await activate(providerPicker.locator('button[data-value="xai"]'));
      await activate(dialog.locator("[data-add-credential]"));
      await saveCredential("Grok Studio");
      await submit.click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await source.inputValue(), executors[1].id);
      assert(await sourcePicker.locator('summary [data-executor-brand="xai"]').isVisible());
      await activate(sourcePicker.locator("summary"));
      await activate(sourcePicker.locator(`button[data-value="${executors[0].id}"]`));
      assert.equal(await source.inputValue(), executors[0].id);
      await activate(sourcePicker.locator("summary"));
      await activate(sourcePicker.locator(`button[data-value="${executors[1].id}"]`));
      assert.equal(await source.inputValue(), executors[1].id);
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      assert.equal((await page.locator("body").textContent()).includes("fixture-browser-key"), false);
      await output.selectOption("image");
      assert.equal(await source.inputValue(), executors[1].id);
      await output.selectOption("video");
      assert.equal(await source.inputValue(), "");

      await page.goto(app.base + "/settings/media-credentials");
      const preferredRow = credentialSettings.locator(`[data-credential-row="${preferredCredential}"]`);
      await activate(preferredRow.locator("[data-credential-edit]"));
      await saveCredential("Studio rotated", undefined, "fixture-rotated-key");
      assert.equal(executors[0].credentialId, preferredCredential);
      assert.equal(executors[0].revision, 1);
      assert.equal(credentials[0].revision, 2);
      await preferredRow.getByRole("heading", { name: "Studio rotated", exact: true }).waitFor();
      const grokCredentialRow = credentialSettings.locator(`[data-credential-row="${executors[1].credentialId}"]`);
      await activate(grokCredentialRow.locator("[data-credential-remove]"));
      await grokCredentialRow.getByText(messages.credentialRemoveInUse, { exact: true }).waitFor();
      await activate(grokCredentialRow.locator("[data-credential-confirm]"));
      await credentialSettings.getByText(messages.credentialRemoved, { exact: true }).waitFor();
      await page.goto(app.base + "/settings/media-executors");
      await settings.locator('button[data-executor-filter="audio"]').click();
      await add.click();
      assert(await category("audio").locator("input").isChecked());
      assert.equal(await model.inputValue(), "audio-model");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      const chooseCli = async () => {
        await add.click();
        await category("cli").click();
      };
      await chooseCli();
      const packages = dialog.locator(".media-cli-registrations");
      await packages.getByRole("heading", { name: messages.mediaCliSettings }).waitFor();
      const packageRow = packages.locator(`[data-media-cli-package="${cli.id}"]`);
      const details = packageRow.locator("summary");
      await details.focus();
      await page.keyboard.press("Enter");
      await packageRow.getByText("<b>Submit and download.</b>", { exact: true }).waitFor();
      assert.equal(await packageRow.locator("b").count(), 0);
      const register = packageRow.getByRole("button", { name: messages.mediaCliRegister });
      if (width < 768) {
        assert((await details.boundingBox()).height >= 44);
        assert((await register.boundingBox()).height >= 44);
      }
      await page.screenshot({ path: join(proof, `cli-review-${locale}-${width}.png`) });
      await register.focus();
      await page.keyboard.press("Enter");
      await packageRow.getByText(messages.mediaCliChecking, { exact: true }).waitFor();
      assert(await register.isDisabled());
      await packageRow.getByText(messages.mediaCliVerificationFailed, { exact: true }).waitFor();
      assert.equal(cliPosts, 1);
      await register.focus();
      await page.keyboard.press("Enter");
      const registered = packageRow.getByText(messages.mediaCliRegistered, { exact: true });
      await registered.waitFor();
      assert.equal(cliPosts, 2);
      assert.equal(await registered.evaluate((element) => document.activeElement === element), true);
      const registrationWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(registrationWidth <= width, `CLI settings overflowed at ${width}px: ${registrationWidth}`);
      await page.screenshot({ path: join(proof, `cli-registration-${locale}-${width}.png`) });
      await provider.locator(`option[value="${cli.id}"]`).waitFor({ state: "attached" });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.reload();
      await chooseCli();
      await packageRow.getByText(messages.mediaCliRegistered, { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      const alternate = locale === "en" ? "zh-CN" : "en";
      const switched = JSON.parse(
        await readFile(new URL(`../../src/shared/i18n/locales/${alternate}/creation.json`, import.meta.url), "utf8"),
      );
      await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), alternate);
      await settings.getByRole("heading", { name: switched.mediaSettings, exact: true }).waitFor();
      await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), locale);
      await settings.getByRole("heading", { name: messages.mediaSettings, exact: true }).waitFor();
      mayManageCli = false;
      const memberReply = page.waitForResponse(
        (response) => response.url().endsWith("/api/personal/creation-media-cli") && response.status() === 403,
      );
      await chooseCli();
      await memberReply;
      await packages.waitFor({ state: "hidden" });
      await provider.locator(`option[value="${cli.id}"]`).waitFor({ state: "attached" });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      const firstRow = settings.locator(".executor-row").first();
      await firstRow.locator("[data-executor-remove]").click();
      await firstRow.getByText(messages.executorRemoveConfirm, { exact: true }).waitFor();
      await firstRow.locator("[data-executor-cancel]").click();
      assert.equal(executors.length, 2);
      await firstRow.locator("[data-executor-remove]").click();
      await firstRow.locator("[data-executor-confirm]").click();
      await settings.getByText(messages.executorRemoved, { exact: true }).waitFor();
      assert.equal(executors.length, 1);
      workerConfigured = false;
      await page.reload();
      const workerNotice = page.getByText(messages.mediaWorkerUnavailable, { exact: true });
      await workerNotice.waitFor();
      assert(await add.isDisabled());
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(pageWidth <= width, `Executor settings overflowed at ${width}px: ${pageWidth}`);
      if (locale === "zh-HK") await page.screenshot({ path: join(proof, "worker-unconfigured-390.png") });
      assert.deepEqual(errors, []);
      console.log(
        `${locale} ${width}: media source, redacted settings, CLI retry, keyboard focus, locale switching and member access`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await app?.dispose();
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
}
