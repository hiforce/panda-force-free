import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_PROJECT_MODEL_PROOF || ".artifacts/harness-project-model";
await mkdir(output, { recursive: true });
const command = (file) => new URL("../support/" + file, import.meta.url).pathname;
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  models: [
    { id: "gpt-fixture", model: "gpt-fixture", displayName: "GPT Fixture", isDefault: true },
    { id: "gpt-fixture-alt", model: "gpt-fixture-alt", displayName: "GPT Alternate Fixture" },
  ],
  async prepareState({ dir }) {
    const home = join(dir, "antigravity-account");
    await mkdir(home);
    await writeFile(join(home, "signed-in"), "");
    const grok = join(dir, "grok-account");
    await mkdir(grok);
    await writeFile(
      join(grok, "auth.json"),
      JSON.stringify({ fixture: { access_token: "fixture", projectModels: true } }),
    );
    await writeFile(join(dir, "zcode-provider.json"), "{}");
  },
  extraEnvironment: ({ dir }) => ({
    PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES: JSON.stringify([
      {
        id: "antigravity",
        name: "Antigravity CLI",
        accountHome: join(dir, "antigravity-account"),
        command: command("antigravity-acp-fixture.mjs"),
      },
    ]),
    PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
      {
        id: "grok-local",
        name: "Grok Build",
        command: command("grok-acp-fixture.mjs"),
        accountHome: join(dir, "grok-account"),
      },
    ]),
    PANDA_FORCE_ZCODE_HARNESS_PROFILES: JSON.stringify(
      ["zcode-local", "zcode-local-alt"].map((id) => ({
        id,
        name: id,
        command: command("zcode-stdio-fixture.mjs"),
        builtinConfig: join(dir, "zcode-provider.json"),
        providerConfig: join(dir, "zcode-provider.json"),
        providerId: "fixture",
        model: id + "-model",
      })),
    ),
  }),
});
const runtimeCases = [
  [
    "antigravity",
    "gemini-fixture",
    "gemini-fixture-pro",
    "Antigravity Pro fixture reply.",
    "Antigravity reply (high).",
  ],
  ["codex", "gpt-fixture", "gpt-fixture-alt"],
  [
    "grok-local",
    "grok-fixture",
    "grok-fixture-alt",
    "Grok alternate reply completed.",
    "Grok fixture reply completed.",
  ],
  [
    "zcode-local",
    "zcode-local-model",
    "zcode-local-alt-model",
    "Fixture ZCode build active.",
    "Fixture ZCode build active.",
    "zcode-local-alt",
  ],
];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
        colorScheme: width < 768 ? "dark" : "light",
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", language);
      }, locale);
      const api = async (path, data) => {
        const response = await context.request.fetch(app.base + path, {
          method: data ? "POST" : "GET",
          headers: { Origin: app.base },
          data,
        });
        assert(response.ok(), path + " returned " + response.status());
        return response.json();
      };
      const catalog = await api("/api/projects");
      const code = "model-fixture-" + locale.toLowerCase();
      const projects = await api("/api/projects", {
        name: "Model fixture " + locale,
        code,
        revision: catalog.revision,
        operationId: crypto.randomUUID(),
      });
      const project = projects.projects.find((entry) => entry.code === code);
      assert(project);
      const conversations = "/api/personal/harness/conversations";
      for (const [runtime, original, alternate, reply, nextReply, alternateRuntime] of locale.startsWith("zh-") &&
      locale !== "zh-CN"
        ? runtimeCases.slice(0, 1)
        : runtimeCases) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const openModel = async (model, nextRuntime) => {
            await page.locator("#composerSettingsButton").click();
            await page.locator('[data-composer-setting="model"]').click();
            const dialog = page.locator("#sessionSettingsDialog");
            if (nextRuntime) await dialog.locator('[name="session-runtime-runtime"]').selectOption(nextRuntime);
            await dialog.locator('[name="session-runtime-model"]').selectOption(model);
            return dialog;
          };
          const save = async (dialog) => {
            await dialog.locator('button[type="submit"]').click();
            const error = page.locator("#persistentErrors:visible");
            await Promise.race([dialog.waitFor({ state: "hidden" }), error.waitFor()]);
            assert.equal(await error.count(), 0, await error.allInnerTexts().then((values) => values.join("\n")));
          };
          await page.goto(app.base + "/project?id=" + project.id + "&tab=sessions");
          await page.locator('[data-wb="project-new"]').first().click();
          await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
          assert.equal(await page.locator("#sessionProjectSelect").inputValue(), project.id);
          await page.locator("#harnessButton").click();
          await page.locator(`[data-harness-select="${runtime}"]`).click();
          await page.locator("#harnessMenu").waitFor({ state: "hidden" });

          const before = (await api(conversations)).conversations.length;
          const draft = "Keep the draft and use the newly selected model.";
          await page.locator("#prompt").fill(draft);
          const dialog = await openModel(alternate, alternateRuntime);
          if (runtime === "antigravity") {
            await page.screenshot({ path: join(output, `${locale}-${width}.png`), scale: "css" });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          }
          await save(dialog);
          assert.equal(await page.locator("#prompt").inputValue(), draft);
          assert.equal((await api(conversations)).conversations.length, before);

          const send = async (model, expectedRuntime, expectedReply) => {
            const previousCalls = app.calls().length;
            await page.locator("#sendButton").click();
            await page.waitForURL("**/task/*");
            const rawId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
            if (expectedRuntime === "codex") {
              await waitFor(() =>
                app
                  .calls()
                  .slice(previousCalls)
                  .some(
                    (call) =>
                      call.method === "turn/start" && call.params.threadId === rawId && call.params.model === model,
                  ),
              );
              return;
            }
            const id = rawId.replace(/^harness:/, "");
            await waitFor(async () => {
              const snapshot = await api(conversations + "/" + id);
              return snapshot.run?.model === model && snapshot.run.status === "complete";
            });
            const snapshot = await api(conversations + "/" + id);
            assert.equal(snapshot.conversation.projectId, project.id);
            assert.equal(snapshot.run.runtimeId, expectedRuntime);
            await page.getByText(expectedReply, { exact: true }).last().waitFor();
          };
          await send(alternate, alternateRuntime ?? runtime, reply);
          await save(await openModel(original, alternateRuntime ? runtime : undefined));
          await page.locator("#prompt").fill("Send the next turn with the original model.");
          await send(original, runtime, nextReply);
          assert.deepEqual(errors, []);
          console.log(
            `${runtime} model selection passed before and after session creation for ${locale} at ${width}px.`,
          );
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
