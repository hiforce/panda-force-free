import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_CREATION_RUNTIME_PROOF || ".artifacts/creation-runtime-controls";
const nativeCreationFile = {
  name: "native-proof.html",
  kind: "web",
  encoding: "utf8",
  content:
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Native artifact proof</title><p>Native output proof.</p></html>\n',
};
const nativeCreationImage = {
  name: "native-proof.png",
  kind: "image",
  encoding: "base64",
  content: (
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "#284674" } })
      .png()
      .toBuffer()
  ).toString("base64"),
};
const modelsByRuntime = ["glm-fixture-a", "glm-fixture-b"];
const engineIds = ["creation-zcode-primary", "creation-zcode-secondary"];
const app = await createAppFixture({
  applicationCreation: true,
  startupTimeoutMs: 60000,
  extraEnvironment({ dir }) {
    const profiles = engineIds.map((id, index) => {
      const providerConfig = join(dir, `${id}.json`);
      writeFileSync(
        providerConfig,
        JSON.stringify({
          applicationProbe: true,
          creationReply: `Scoped creation reply ${index + 1}.`,
          nativeCreationFile,
          nativeCreationImage,
        }),
      );
      return {
        id,
        name: `ZCode Fixture ${index + 1}`,
        providerConfig,
        builtinConfig: providerConfig,
        providerId: "fixture",
        model: modelsByRuntime[index],
        efforts: ["low", "high"],
        defaultEffort: "low",
        command: new URL("../support/zcode-stdio-fixture.mjs", import.meta.url).pathname,
      };
    });
    return { PANDA_FORCE_ZCODE_HARNESS_PROFILES: JSON.stringify(profiles) };
  },
});
const endpoint = "/api/personal/document-creations";
await mkdir(output, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1190, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale, hasTouch: width < 768 });
      await context.addInitScript((language) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", language);
      }, locale);
      await app.signIn(context);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const runtime = page.locator("#harnessButton");
      const selectedRuntime = (name) => page.locator(`#harnessButton[aria-label$=" · ${name}"]`).waitFor();
      const composer = page.locator("#prompt");
      const settings = page.locator("#composerSettingsButton");
      const choices = page.locator("#harnessMenu [data-harness-select]");
      const file = (stage) => join(output, `${width}-${locale}-${stage}.png`);
      await page.goto(app.base + "/create");
      await selectedRuntime("Codex");
      const draft = "Explain the intended audience of this creation.";
      await composer.fill(draft);
      await runtime.focus();
      await page.keyboard.press("Enter");
      await choices.first().waitFor();
      const ids = await choices.evaluateAll((items) => items.map((item) => item.dataset.harnessSelect));
      assert(ids.includes("codex"));
      assert(engineIds.every((id) => ids.includes(id)));
      await page.screenshot({ path: file("runtime") });
      await page.keyboard.press("Escape");
      await runtime.click();
      await page.locator(`[data-harness-select="${engineIds[0]}"]`).click();
      await selectedRuntime("ZCode Fixture 1");
      assert.equal(await composer.inputValue(), draft);
      await settings.click();
      await page.locator('[data-composer-setting="model"]').click();
      const dialog = page.locator("#sessionSettingsDialog");
      const instance = dialog.locator('[name="session-runtime-runtime"]');
      const model = modelsByRuntime[0];
      const models = dialog.locator('[name="session-runtime-model"]');
      await models.locator(`option[value="${model}"]`).waitFor({ state: "attached" });
      assert.equal(await instance.inputValue(), engineIds[0]);
      await models.selectOption(model);
      await dialog.locator('[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await composer.inputValue(), draft);

      async function send(expectedId, expectedReply) {
        const posted = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === "POST" && [endpoint, endpoint + "/message"].includes(url.pathname);
        });
        await page.locator("#sendButton").click();
        const accepted = await posted;
        assert.equal(accepted.status(), 202, await accepted.text());
        assert.equal(accepted.request().postDataJSON().runtimeId, expectedId);
        const {
          task: { id },
        } = await accepted.json();
        await page.locator("#conversation").getByText(expectedReply, { exact: true }).waitFor();
        const detail = await waitFor(async () => {
          const response = await context.request.get(app.base + endpoint + "/detail?id=" + id);
          const { task } = await response.json();
          if (task?.failure) throw Error(task.failure);
          return task?.state === "replied" ? task : null;
        });
        assert.equal(detail.runtimeId, expectedId);
        assert.equal(detail.model, modelsByRuntime[engineIds.indexOf(expectedId)]);
      }
      await send(engineIds[0], "Scoped creation reply 1.");
      await selectedRuntime("ZCode Fixture 1");
      await runtime.click();
      await page.locator(`[data-harness-select="${engineIds[1]}"]`).click();
      await selectedRuntime("ZCode Fixture 2");
      await composer.fill("Explain what is missing from the earlier answer.");
      await send(engineIds[1], "Scoped creation reply 2.");
      await page.reload();
      await selectedRuntime("ZCode Fixture 2");
      assert(await page.locator("#conversation").getByText("Scoped creation reply 1.", { exact: true }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: file("followup") });
      async function verifyNativeFile(prompt, file) {
        await composer.fill(prompt);
        const nativePost = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname === endpoint + "/message",
        );
        await page.locator("#sendButton").click();
        const delivery = await nativePost;
        assert.equal(delivery.status(), 202, await delivery.text());
        assert.equal(delivery.request().postDataJSON().runtimeId, engineIds[1]);
        const {
          task: { id: nativeId },
        } = await delivery.json();
        const delivered = await waitFor(async () => {
          const response = await context.request.get(app.base + endpoint + "/detail?id=" + nativeId);
          const { task } = await response.json();
          if (task?.failure) throw Error(task.failure + " " + app.logs());
          return task?.state === "succeeded" ? task.artifact : null;
        });
        assert.equal(delivered.kind, file.kind);
        assert.equal(delivered.source.name, file.name);
        const card = page.locator(`.creation-task[data-creation-task="${nativeId}"][data-state="succeeded"]`);
        const downloading = page.waitForEvent("download");
        await card.locator("a[download]").click();
        const original = await downloading;
        assert.equal(original.suggestedFilename(), file.name);
        assert.deepEqual(await readFile(await original.path()), Buffer.from(file.content, file.encoding));
      }
      await verifyNativeFile("Produce the native file.", nativeCreationFile);
      if (locale === "en") await verifyNativeFile("Produce the native image.", nativeCreationImage);
      await page.screenshot({ path: file("native-file") });
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        draftPreserved: true,
        changesReachNativeRuntime: true,
        reloadPreserved: true,
        nativeDownloadMatches: true,
      });
      console.log(`${locale} ${width}: shared footer selects and runs distinct creation instances`);
    } finally {
      await browser.close();
    }
  }
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, records }) + "\n");
} finally {
  await app.dispose();
}
