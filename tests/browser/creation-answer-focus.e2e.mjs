import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = process.env.PANDA_CREATION_ANSWER_FOCUS_PROOF || ".artifacts/creation-answer-focus";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  models: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true }],
});
const prefix = "/api/personal/document-creations",
  records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1200, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 920 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript((value) => {
        if (window !== top || !/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", value);
        localStorage.setItem("panda-force-theme", "dark");
      }, locale);
      await app.signIn(context);
      const options = await (await context.request.get(app.base + prefix + "/options")).json(),
        id = crypto.randomUUID();
      const start = await context.request.post(app.base + prefix, {
        headers: { Origin: app.base },
        data: {
          id,
          projectId: "personal",
          parentId: null,
          treeVersion: 0,
          locale,
          prompt: "Write a short handbook for new users.",
          profileId: options.defaultProfileId,
          selections: [options.defaultWorkflow],
        },
      });
      assert.equal(start.status(), 202, await start.text());
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
      const question = page.locator(".creation-session-status .user-input-card");
      await question.locator(".user-input-option").last().click();
      const field = question.locator(".user-input-custom");
      await field.fill("For PandaForce users");
      await field.evaluate((node) => node.setSelectionRange(4, 14));
      let update = 0;
      const detailRoute = "**/document-creations/detail?*";
      await page.route(detailRoute, async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const body = await response.json();
        if (body.task.id === id && body.task.question) {
          await Bun.sleep(300);
          body.task.progress.push({
            stage: "message",
            generation: body.task.generation,
            at: Date.now(),
            text: `Background update while answering ${++update}`,
          });
        }
        await route.fulfill({ response, json: body });
      });
      for (const number of [1, 2]) {
        await page
          .locator("#conversation")
          .getByText(`Background update while answering ${number}`, { exact: true })
          .waitFor();
        assert.deepEqual(
          await field.evaluate((node) => [document.activeElement === node, node.selectionStart, node.selectionEnd]),
          [true, 4, 14],
          "Progress refresh must retain the answer field focus and selection",
        );
      }
      await page.keyboard.insertText("新用户");
      assert.equal(await field.inputValue(), "For 新用户 users");
      await page.unroute(detailRoute);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/question-focus-${locale}-${width}.png` });

      await page.route("**/document-creations/answer", (route) => route.fulfill({ status: 503 }), { times: 1 });
      const submit = question.locator(".user-input-submit");
      await submit.click();
      await question.locator(".user-input-error").waitFor();
      assert.equal(await field.inputValue(), "For 新用户 users");
      const submitted = page.waitForResponse((response) => response.url().endsWith(prefix + "/answer"));
      await submit.click();
      const answer = await submitted;
      assert.equal(answer.status(), 200, await answer.text());
      assert.deepEqual(answer.request().postDataJSON().answers.audience.answers, ["For 新用户 users"]);
      await question.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      records.push({ locale, width, answerFocusAndSelectionDuringRefresh: true, submissionRetryPreservedDraft: true });
      console.log(`${locale} ${width}: answer focus, selection and submission retry verified`);
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.dispose();
}
