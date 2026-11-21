import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = process.env.PANDA_CREATION_PROGRESS_ARTIFACTS || ".artifacts/creation-progress";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  startupTimeoutMs: 60000,
  models: [
    {
      id: "progress-model",
      model: "progress-model",
      displayName: "Progress model",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
});
const records = [];
const labels = {
  en: ["Preparing the brief, skills and attachments", "Generate or edit an image", "Completed"],
  "zh-CN": ["正在准备需求、技能与附件", "生成或编辑图片", "已完成"],
  "zh-HK": ["正在準備需求、技能與附件", "產生或編輯圖片", "已完成"],
  "zh-TW": ["正在準備需求、技能與附件", "產生或編輯圖片", "已完成"],
};
try {
  for (const locale of Object.keys(labels))
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height: width < 768 ? 844 : 1000 },
          locale,
          isMobile: width < 768,
          hasTouch: width < 768,
        });
      try {
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        await app.signIn(context);
        const options = await (await context.request.get(app.base + "/api/personal/document-creations/options")).json();
        const id = crypto.randomUUID(),
          activityId = crypto.randomUUID(),
          at = Date.now();
        const submitted = await context.request.post(app.base + "/api/personal/document-creations", {
          headers: { Origin: app.base },
          data: {
            id,
            projectId: "personal",
            treeVersion: 0,
            parentId: null,
            locale,
            prompt: "Create a progress example",
            profileId: options.defaultProfileId,
            selections: [options.defaultWorkflow],
          },
        });
        assert.equal(submitted.status(), 202, await submitted.text());
        let completed = false,
          failRead = false,
          reads = 0;
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/document-creations/detail?*", async (route) => {
          if (failRead) return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const body = await response.json();
          reads++;
          body.task.state = completed ? "succeeded" : "running";
          body.task.failure = null;
          body.task.question = null;
          body.task.clarifications = [];
          body.task.updatedAt = at + reads;
          if (!completed) body.task.artifact = null;
          body.task.progress = [
            { stage: "preparing", generation: 1, at },
            { stage: "started", generation: 1, at: at + 1 },
            {
              stage: "message",
              generation: 1,
              at: at + 2,
              text: "Visible work update. <script>globalThis.progressInjection=true</script>",
            },
            {
              stage: "activity",
              id: activityId,
              generation: 1,
              at: at + 3,
              operation: "panda_images_render",
              status: completed ? "completed" : "running",
            },
          ];
          return route.fulfill({ response, json: body });
        });
        await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
        const text = page.locator("#conversation");
        await text.getByText(labels[locale][0], { exact: true }).waitFor();
        const operation = text.locator(".message-text").filter({ hasText: labels[locale][1] });
        await operation.waitFor();
        assert.equal(await text.locator("script").count(), 0);
        assert.equal(await page.evaluate(() => globalThis.progressInjection), undefined);
        const draft = page.locator("#prompt");
        await draft.fill("Keep this update draft");
        const nativeInputs = app.calls().filter((c) => c.method === "turn/start").length;
        const firstReads = reads;
        await page.waitForTimeout(1800);
        assert(reads > firstReads);
        assert.equal(await draft.inputValue(), "Keep this update draft");
        await operation.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `running-${locale}-${width}.png`) });
        failRead = true;
        await page.locator('[data-phase="error"]').waitFor();
        assert.equal(await draft.inputValue(), "Keep this update draft");
        assert.equal(await operation.count(), 1);
        failRead = false;
        completed = true;
        await page.locator('[data-phase="error"] button').click();
        await operation.filter({ hasText: labels[locale][2] }).waitFor();
        assert.equal(await operation.count(), 1, "The same operation updates rather than appending duplicate rows");
        await page.reload();
        await operation.filter({ hasText: labels[locale][2] }).waitFor();
        assert.equal(
          app.calls().filter((c) => c.method === "turn/start").length,
          nativeInputs,
          "Recovery does not replay the model request",
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(out, `completed-${locale}-${width}.png`) });
        assert.deepEqual(errors, []);
        records.push({
          locale,
          width,
          stages: true,
          toolOutcome: true,
          timestamp: true,
          reload: true,
          pollFailurePreservesDraft: true,
          noReplay: true,
        });
      } finally {
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
        await browser.close();
      }
    }
  await writeFile(
    join(out, "result.json"),
    JSON.stringify({ passed: true, records, externalModelCalls: false }, null, 2),
  );
} finally {
  await app.dispose();
}
