import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture } from "./app-fixture.mjs";
import { launchOptions, artifact } from "./browser-runtime.mjs";

const fixture = await createAppFixture({ sharedApprovals: true });
let browser;
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  await fixture.signIn(context);
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.removeItem("panda-force-locale");
    Object.defineProperty(navigator, "languages", { value: ["en-US", "zh-CN"] });
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  const approval = page.locator(".approval-card");
  await approval.waitFor();
  await page.evaluate(async () => {
    const api = globalThis.__pandaForceDebug;
    await api.request({
      id: "locale-question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "old-alpha",
        turnId: "locale-turn",
        questions: [
          {
            id: "choice",
            header: "Native header",
            question: "Settings 原生问题",
            isOther: true,
            options: [{ label: "Keep original", description: "Native description" }],
          },
        ],
      },
    });
    api.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "locale-command",
      item: {
        id: "locale-command",
        type: "commandExecution",
        command: "printf 'Settings'",
        aggregatedOutput: "CLI original: Settings\n错误原文",
        exitCode: 0,
      },
    });
    api.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "locale-reasoning",
      item: {
        id: "locale-reasoning",
        type: "reasoning",
        summary: ["Thinking Settings 原生摘要"],
      },
    });
  });
  const question = page.locator('[data-request-id="locale-question"]');
  await question.locator('input[type="radio"]').first().check();
  await page.locator("#prompt").fill("My unsent Settings draft");
  await page.locator("#prompt").focus();
  await page.locator("#prompt").evaluate((input) => {
    input.setSelectionRange(3, 9);
    globalThis.localeOriginalInput = input;
    globalThis.localeOriginalApproval = document.querySelector(".approval-card");
    globalThis.localeOriginalQuestion = document.querySelector('[data-request-id="locale-question"]');
    globalThis.localeNativeOutput = [...document.querySelectorAll(".command-shell-output pre")].at(-1);
  });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  assert.equal(await approval.locator(".approval-primary").innerText(), "允许本次");
  assert.equal(await question.locator('[type="submit"]').innerText(), "提交回答");
  assert.equal(await question.locator(".user-input-question").innerText(), "Settings 原生问题");
  assert.equal(await question.locator('input[type="radio"]').first().isChecked(), true);
  const preserved = await page.evaluate(() => ({
    input: localeOriginalInput === document.querySelector("#prompt"),
    focus: document.activeElement === localeOriginalInput,
    draft: localeOriginalInput.value,
    selection: [localeOriginalInput.selectionStart, localeOriginalInput.selectionEnd],
    approval: localeOriginalApproval === document.querySelector(".approval-card"),
    question: localeOriginalQuestion === document.querySelector('[data-request-id="locale-question"]'),
    output: localeNativeOutput.isConnected && localeNativeOutput.textContent,
    title: document.querySelector("#threadTitle").textContent,
  }));
  assert.deepEqual(preserved, {
    input: true,
    focus: true,
    draft: "My unsent Settings draft",
    selection: [3, 9],
    approval: true,
    question: true,
    output: "CLI original: Settings\n错误原文",
    title: "Old alpha session",
  });
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("error", { message: "common.cancel", id: "native-verbatim-error" }),
  );
  assert.equal(await page.locator("#persistentErrors .persistent-error-body p").last().innerText(), "common.cancel");
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
  assert.equal(await approval.locator(".approval-primary").innerText(), "Allow once");
  assert.equal(await question.locator('[type="submit"]').innerText(), "Submit answer");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: artifact("i18n-architecture-interactions.png"), fullPage: false });
  await page.goto(fixture.base + "/projects");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.locator("#wbProjectSearch").fill("Settings project");
  await page.locator("#wbProjectSearch").focus();
  await page.locator("#wbProjectSearch").evaluate((input) => {
    input.setSelectionRange(2, 6);
    globalThis.projectSearchInput = input;
  });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  assert.equal(await page.locator(".workbench-navigation [data-route=projects]").innerText(), "项目");
  assert.equal(await page.locator("#threadTitle").innerText(), "项目");
  assert.equal(await page.locator(".wb-page-heading h1").innerText(), "项目");
  assert.deepEqual(
    await page.evaluate(() => ({
      same: projectSearchInput === document.querySelector("#wbProjectSearch"),
      focus: document.activeElement === projectSearchInput,
      value: projectSearchInput.value,
      selection: [projectSearchInput.selectionStart, projectSearchInput.selectionEnd],
    })),
    { same: true, focus: true, value: "Settings project", selection: [2, 6] },
  );
  await context.close();

  for (const [languages, expected] of [
    [["zh-Hans-SG", "en"], "zh-CN"],
    [["zh-TW", "en"], "en"],
    [["de-DE"], "en"],
  ]) {
    const next = await browser.newContext({ locale: languages[0] });
    await fixture.signIn(next);
    await next.addInitScript(
      (languages) => Object.defineProperty(navigator, "languages", { value: languages }),
      languages,
    );
    const nextPage = await next.newPage();
    await nextPage.goto(fixture.base);
    await nextPage.locator("#workspacePreparation").waitFor({ state: "hidden" });
    assert.equal(await nextPage.locator("html").getAttribute("lang"), expected);
    await next.close();
  }
  const offline = await browser.newContext({ locale: "zh-CN" });
  await fixture.signIn(offline);
  await offline.route("**/locales/zh-CN.json*", (route) => route.abort());
  const offlinePage = await offline.newPage();
  await offlinePage.goto(fixture.base);
  await offlinePage.locator("#workspacePreparation").waitFor({ state: "hidden" });
  assert.equal(await offlinePage.locator("html").getAttribute("lang"), "en");
  await offline.close();
  console.log(
    JSON.stringify({
      browserOrder: true,
      scriptsDistinct: true,
      offlineEnglishFallback: true,
      nativeTextVerbatim: true,
      interactionsPreserved: preserved,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
