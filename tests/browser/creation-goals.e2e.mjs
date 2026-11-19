import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-goals-browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
    applicationCreation: true,
    models: [
      {
        id: "gpt-fixture",
        model: "gpt-fixture",
        isDefault: true,
        displayName: "Fixture model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "xhigh" },
        ],
      },
    ],
  }),
  evidence = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 950 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      const auth = await (await context.request.get(app.base + "/api/auth/status")).json();
      const identity =
        auth.authMode +
        ":" +
        (auth.identity?.id || auth.identity?.username || "local") +
        (auth.directoryScope ? ":" + auth.directoryScope : "");
      await context.addInitScript(
        ({ locale, identity }) => {
          if (window === top && /^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-browser-identity", identity);
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", "aurora");
            if (locale === "zh-HK") localStorage.setItem("panda-force-effort:gpt-fixture", "medium");
          }
        },
        { locale, identity },
      );
      const page = await context.newPage(),
        errors = [],
        posts = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/document-creations/goal"))
          posts.push(request.postDataJSON());
      });
      await page.goto(app.base + "/create");
      await page.locator(".creation-entry-composer #composer").waitFor();
      await page.locator('.creation-discovery-card [data-skill-id="software-prd"]:enabled').waitFor();
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
      const modelHint = await page.evaluate(() =>
        globalThis.__pandaForceI18n.t("common.modelAndReasoningSetting", {
          model: document.querySelector("#modelLabel").textContent,
          level: document.querySelector("#effortLabel").textContent,
        }),
      );
      for (const attribute of ["title", "aria-label"])
        assert.equal(await page.locator("#modelButton").getAttribute(attribute), modelHint);
      await page.locator("#modelButton").click();
      assert.equal(
        await page.locator('#sessionSettingEfforts input[type="range"]').getAttribute("aria-valuetext"),
        await page.evaluate(
          (key) => globalThis.__pandaForceI18n.t(key),
          locale === "zh-HK" ? "common.medium" : "common.extraHigh",
        ),
      );
      await page.screenshot({ path: `${out}/effort-${locale}-${width}.png` });
      if (locale === "zh-TW") {
        await page.locator('#sessionSettingEfforts input[type="range"]').press("Home");
        await page.locator('#sessionSettingsForm [type="submit"]').click();
      } else await page.locator("#sessionSettingsDialog [data-settings-dismiss]").first().click();
      await page.locator('.creation-discovery-card [data-skill-id="software-prd"]').click();
      await page
        .locator("#prompt")
        .fill("Write a complete requirements document with clear acceptance criteria. " + locale);
      const submitted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/personal/document-creations") && response.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const result = await submitted.catch(async (error) => {
        await writeFile(
          `${out}/submission-failed.json`,
          JSON.stringify(
            await page.evaluate(() => ({
              path: location.pathname,
              errors: document.querySelector("#persistentErrors")?.textContent,
              notice: document.querySelector(".creation-session-notice")?.textContent,
              prompt: document.querySelector("#prompt")?.value,
              body: document.body.className,
              submit: document.querySelector("#sendButton")?.outerHTML,
            })),
            null,
            2,
          ),
        );
        await page.screenshot({ path: `${out}/submission-failed.png` });
        throw error;
      });
      assert.equal(result.status(), 202, await result.text());
      assert.equal(
        (await result.json()).task.effort,
        locale === "zh-HK" ? "medium" : locale === "zh-TW" ? "low" : "xhigh",
        "Creation defaults to extreme effort and preserves explicit choices",
      );
      await page.waitForURL("**/creation/**");
      await page.locator(".creation-session-status .user-input-card").waitFor();
      const taskUrl = page.url();
      const inspect = async () => {
        if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      };
      const closeInspector = async () => {
        if (width < 1081 && (await page.locator("#sessionInspector").isVisible()))
          await page.locator('#sessionInspector [data-session-action="close"]').click();
      };
      const openGoal = async () => {
        await inspect();
        await page.locator("#sessionGoalPlan").waitFor({ state: "visible" });
        if (!(await page.locator("#sessionGoalPlan").evaluate((node) => node.open)))
          await page.locator("#sessionGoalPlan > summary").click();
        await page.locator(".goal-status-toggle").click();
        await page.locator("#goalDialog[open]").waitFor();
      };
      await inspect();
      await page.locator("[data-creation-goal]").click();
      await page.locator("#goalDialog[open]").waitFor();
      assert.equal(posts.length, 0, "Opening a goal draft does not start or modify a task");
      await page.locator("#cancelGoalDialog").click();
      await page.locator("[data-creation-goal]").click();
      const objective = "Cover the category tree, inherited fields and per-channel mappings. " + locale;
      await page.locator("#goalDialogObjective").fill(objective);
      await page.locator("#saveGoalDialog").click();
      await page.locator("#goalDialog").waitFor({ state: "hidden" });
      assert.equal(page.url(), taskUrl);
      await page.waitForFunction(() => document.querySelector("#sessionGoalPlan")?.open === true);
      await page.locator("#sessionGoalPlan").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/expanded-${locale}-${width}.png` });
      await page.locator("#sessionGoalPlan > summary").click();
      assert.equal(await page.locator("#sessionGoalPlan").evaluate((node) => node.open), false);
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert.equal(
        await page.locator("#sessionGoalPlan").evaluate((node) => node.open),
        false,
        "Active refresh retains a deliberate collapse",
      );
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#goalStatus")?.getAttribute("data-state") === "active");
      await page.waitForFunction(() => document.querySelector("#sessionGoalPlan")?.open === true);
      await closeInspector();
      await page.locator("#prompt").fill("Keep this unfinished message. " + locale);
      const uploaded = page.waitForResponse(
        (response) =>
          response.url().includes("/api/creation-materials?name=") && response.request().method() === "POST",
      );
      await page.locator("#attachmentInput").setInputFiles({
        name: "fields.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("field,required\nsize,true\n"),
      });
      assert.equal((await uploaded).status(), 201);
      await page.waitForFunction(() =>
        globalThis.__pandaForceDebug.state.composerAttachments.some(
          (file) => file.name === "fields.csv" && file.status === "ready",
        ),
      );
      await openGoal();
      assert.equal(await page.locator("#goalDialogObjective").inputValue(), objective);
      await page.screenshot({ path: `${out}/active-${locale}-${width}.png` });
      await page.locator("#pauseGoalDialog").click();
      await page.locator("#resumeGoalDialog").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector("#goalStatus")?.getAttribute("data-state") === "paused");
      await page.screenshot({ path: `${out}/goal-${locale}-${width}.png` });
      await page.locator("#cancelGoalDialog").click();
      await page.reload();
      await page.locator(".creation-session-status").waitFor();
      await openGoal();
      assert.equal(await page.locator("#goalDialogObjective").inputValue(), objective);
      await page.locator("#resumeGoalDialog").waitFor({ state: "visible" });
      if (locale === "en") {
        let dropped = false;
        await page.route("**/document-creations/goal", async (route) => {
          if (!dropped && route.request().postDataJSON().action === "set") {
            dropped = true;
            await route.fetch();
            await route.abort("failed");
          } else await route.continue();
        });
        await page.locator("#goalDialogObjective").fill(objective + " Preserve permissions.");
        await page.locator("#saveGoalDialog").click();
        await page.locator("#goalDialogError").waitFor({ state: "visible" });
        await page.locator("#cancelGoalDialog").click();
        await closeInspector();
        await page.locator(".creation-session-notice button").click();
        await page.waitForFunction(() => !document.querySelector(".creation-session-notice button"));
        const sets = posts.filter((post) => post.action === "set");
        assert.equal(
          sets.at(-1).id,
          sets.at(-2).id,
          "An uncertain goal acknowledgement must reuse the command identity",
        );
        await openGoal();
        assert.equal(await page.locator("#goalDialogObjective").inputValue(), objective + " Preserve permissions.");
      }
      await page.locator("#resumeGoalDialog").click();
      await page.locator("#pauseGoalDialog").waitFor({ state: "visible" });
      await page.locator("#cancelGoalDialog").click();
      assert.equal(
        await page.locator("#sessionGoalPlan").evaluate((node) => node.open),
        true,
        "Resuming reveals the active goal",
      );
      await closeInspector();
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this unfinished message. " + locale);
      assert.match(await page.locator("#composerAttachments").textContent(), /fields.csv/);
      assert.equal(await page.locator('#composerSkills [data-selected-skill="software-prd"]').count(), 1);
      await openGoal();
      await page.locator("#clearGoalDialog").click();
      await page.locator("#goalDialog").waitFor({ state: "hidden" });
      await page.locator("#sessionGoalPlan").waitFor({ state: "hidden" });
      assert.equal(page.url(), taskUrl);
      if (locale === "en") {
        await closeInspector();
        const question = page.locator(".creation-session-status .user-input-card");
        await question.locator(".user-input-option").first().click();
        await question.locator(".user-input-submit").click();
        await page.locator("[data-creation-open]:visible").waitFor();
        await inspect();
        await page.locator("[data-creation-goal]").click();
        await page
          .locator("#goalDialogObjective")
          .fill("Polish the saved document and preserve its complete requirements.");
        await page.locator("#saveGoalDialog").click();
        await page.waitForURL((url) => url.pathname.startsWith("/creation/") && url.toString() !== taskUrl);
        await page.locator(".creation-session-status .user-input-card").waitFor();
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this unfinished message. " + locale);
        assert.match(await page.locator("#composerAttachments").textContent(), /fields.csv/);
        const prior = await context.request.get(
          app.base + "/api/personal/document-creations/detail?id=" + new URL(taskUrl).pathname.split("/").at(-1),
        );
        assert((await prior.json()).task.artifact);
      }
      await closeInspector();
      await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
      await page.waitForFunction(
        () => globalThis.__pandaForceDebug.state.active?.id === "old-alpha" && location.pathname === "/task/old-alpha",
      );
      const nativeHint = await page.evaluate(() =>
        globalThis.__pandaForceI18n.t("common.modelAndReasoningSetting", {
          model: document.querySelector("#modelLabel").textContent,
          level: document.querySelector("#effortLabel").textContent,
        }),
      );
      for (const attribute of ["title", "aria-label"])
        assert.equal(await page.locator("#modelButton").getAttribute(attribute), nativeHint);
      const badCalls = app.calls().filter((call) => call.params?.threadId?.startsWith("creation:"));
      assert.equal(badCalls.length, 0, "Public creation identities never reach native engine RPCs");
      assert.deepEqual(errors, []);
      evidence.push({
        locale,
        width,
        goalCommands: posts.length,
        persistentGoal: true,
        pauseResume: true,
        draftAndMaterialRetained: true,
        nativeIdentityIsolated: true,
      });
      console.log("Verified creation goal controls", locale, width);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/result.json`, JSON.stringify(evidence, null, 2));
  console.log("Creation goal shared controls and recovery passed", JSON.stringify(evidence));
} finally {
  await app.dispose();
}
