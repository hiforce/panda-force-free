import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const objective = "Continue the complete project document workflow without reducing its scope",
  fixture = await createAppFixture({
    goals: [
      {
        threadId: "old-alpha",
        goalId: "saved-goal",
        objective,
        status: "paused",
        tokenBudget: 2500,
        tokensUsed: 312,
        timeUsedSeconds: 84,
      },
      { threadId: "old-beta", goalId: "independent-goal", objective: "An independent goal", status: "blocked" },
    ],
  }),
  directory = ".artifacts/goal-resume-browser",
  evidence = [];
await mkdir(directory, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      await fixture.rpc("thread/goal/set", { threadId: "old-alpha", status: "paused", origin: "user" });
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
      await fixture.signIn(context);
      await context.addInitScript((locale) => {
        if (window === window.top && /^https?:$/.test(location.protocol))
          localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.on("websocket", (socket) =>
        socket.on("framesent", (event) => {
          const call = JSON.parse(String(event.payload));
          if (call.method === "thread/goal/set") requests.push(call);
        }),
      );
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.base + "/task/old-alpha");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.goals.get("old-alpha")?.status === "paused");
      if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionGoalPlan").waitFor({ state: "visible" });
      await page.locator("#sessionGoalPlan > summary").click();
      await page
        .locator("#goalStatus .goal-status-resume")
        .waitFor({ state: "visible" })
        .catch(async (error) => {
          const diagnostic = await page.evaluate(() => ({
            goal: globalThis.__pandaForceDebug.state.goals.get("old-alpha"),
            html: document.querySelector("#sessionGoalPlan").outerHTML,
            errors: document.querySelector("#persistentErrors")?.textContent,
          }));
          await page.screenshot({ path: `${directory}/${width}-failed.png` });
          await writeFile(`${directory}/${width}-failed.json`, JSON.stringify(diagnostic, null, 2));
          throw error;
        });
      assert.equal(await page.locator("#goalStatus").getAttribute("data-state"), "paused");
      await page.locator(".goal-status-toggle").click();
      assert.equal(await page.locator("#goalDialogObjective").inputValue(), objective);
      assert.equal(
        await page
          .locator("#resumeGoalDialog")
          .textContent()
          .then((text) => text.trim()),
        locale === "en" ? "Resume goal" : "恢复 Goal",
      );
      await page.locator("#goalDialogObjective").fill("An unsaved objective edit");
      await page.evaluate(() => {
        document.querySelector("#prompt").value = "Keep my unsent message";
      });
      await writeFile(`${fixture.dir}/goal-resume-fail`, "Fail the next disposable native resume");
      const start = fixture.calls().length;
      await page.locator("#resumeGoalDialog").click();
      await page.locator("#goalDialogError").waitFor({ state: "visible" });
      assert.equal(await page.locator("#goalStatus").getAttribute("data-state"), "paused");
      assert.equal(await page.locator("#resumeGoalDialog").isEnabled(), true);
      await page.locator("#resumeGoalDialog").click();
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.goals.get("old-alpha")?.status === "active");
      assert.equal(await page.locator("#goalDialogObjective").inputValue(), "An unsaved objective edit");
      assert.equal(await page.locator("#prompt").inputValue(), "Keep my unsent message");
      assert.equal(await page.locator("#goalDialogError").isVisible(), false);
      assert.equal(await page.locator("#resumeGoalDialog").isVisible(), false);
      const mutations = fixture
        .calls()
        .slice(start)
        .filter((call) => call.method === "thread/goal/set");
      assert.equal(mutations.length, 2);
      for (const mutation of mutations)
        assert.deepEqual(mutation.params, { threadId: "old-alpha", status: "active", origin: "user" });
      const native = (await fixture.rpc("thread/goal/get", { threadId: "old-alpha" })).result.goal;
      assert.equal(native.objective, objective);
      assert.equal(native.tokenBudget, 2500);
      assert.equal(native.tokensUsed, 312);
      assert.equal(native.timeUsedSeconds, 84);
      await page.locator("#cancelGoalDialog").click();
      await fixture.rpc("thread/goal/set", { threadId: "old-alpha", status: "paused", origin: "user" });
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.goals.get("old-alpha")?.status === "paused");
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.goals.get("old-alpha")?.status === "paused");
      if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionGoalPlan").waitFor({ state: "visible" });
      if (!(await page.locator("#sessionGoalPlan").getAttribute("open"))) {
        const opened = await page.locator("#sessionGoalPlan").evaluate((node) => node.open);
        if (!opened) await page.locator("#sessionGoalPlan > summary").click();
      }
      await page.locator(".goal-status-resume").click();
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.goals.get("old-alpha")?.status === "active");
      assert.equal(await page.locator(".goal-status-resume").count(), 0);
      await fixture.rpc("thread/goal/set", { threadId: "old-alpha", status: "paused", origin: "user" });
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.goals.get("old-alpha")?.status === "paused");
      await writeFile(`${fixture.dir}/goal-resume-wait`, "Hold the disposable acknowledgement");
      const requestCount = requests.length;
      await page.locator(".goal-status-resume").click();
      await waitFor(() => !existsSync(`${fixture.dir}/goal-resume-wait`));
      const delayed = requests.slice(requestCount).find((call) => call.params?.status === "active");
      assert.ok(delayed);
      await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-beta"));
      await page.waitForFunction(
        () =>
          globalThis.__pandaForceDebug.state.active?.id === "old-beta" &&
          globalThis.__pandaForceDebug.state.goals.get("old-beta")?.status === "blocked",
      );
      await page.evaluate(() => {
        document.querySelector("#prompt").value = "The other session's draft";
      });
      await writeFile(`${fixture.dir}/goal-resume-release`, "Release the exact original acknowledgement");
      await page.waitForFunction((id) => !globalThis.__pandaForceDebug.state.pending.has(id), delayed.id);
      assert.equal(await page.locator("#prompt").inputValue(), "The other session's draft");
      assert.equal(await page.locator("#goalStatus").getAttribute("data-goal-id"), "independent-goal");
      assert.equal(await page.locator("#goalStatus").getAttribute("data-state"), "blocked");
      await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
      await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active?.id === "old-alpha");
      if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
      await page.evaluate(() =>
        globalThis.__pandaForceDebug.notify("thread/goal/updated", {
          threadId: "old-alpha",
          goal: { status: "paused", objective: "Live paused goal", updatedAt: Date.now() + 1000 },
        }),
      );
      assert.equal(await page.locator("#sessionGoalPlan").isVisible(), true);
      assert.equal(await page.locator("#goalStatus").getAttribute("data-state"), "paused");
      assert.equal(await page.locator(".goal-status-resume").isVisible(), true);
      for (const [index, status] of ["blocked", "usageLimited", "budgetLimited", "complete", "paused"].entries()) {
        await page.evaluate(
          ({ index, status }) =>
            globalThis.__pandaForceDebug.notify("thread/goal/updated", {
              threadId: "old-alpha",
              goal: { status, updatedAt: Date.now() + 2000 + index * 1000 },
            }),
          { index, status },
        );
        assert.ok(await page.locator("#goalStatus").textContent());
        assert.equal(await page.locator(".goal-status-resume").count(), ["paused", "blocked"].includes(status) ? 1 : 0);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${directory}/${width}.png`, fullPage: false });
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        locale,
        persistedPausedGoal: true,
        liveGoalUpdates: true,
        resumePreservesSourceAndDraft: true,
        failureRetry: true,
        reloadRecovery: true,
        crossSessionAcknowledgementIsolation: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${directory}/verified.json`, JSON.stringify({ passed: true, evidence }, null, 2) + "\n");
} finally {
  await fixture.dispose();
}
