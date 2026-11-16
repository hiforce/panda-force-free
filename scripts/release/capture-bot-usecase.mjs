import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../../tests/support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";
import {
  publishingConfig,
  publishingRequest,
  publishingOutcome,
} from "../../examples/bots/product-publishing/scenario.mjs";

// Real UI, fictional task outcomes. An unexpired simulated run prevents worker dispatch.
const output = resolve(process.env.PANDA_FORCE_BOT_SCREENSHOTS || "panda-docs/static/img"),
  captures = [];
await mkdir(output, { recursive: true });
for (const locale of ["en", "zh-CN"]) {
  const zh = locale === "zh-CN",
    app = await createAppFixture({
      account: { type: "apiKey" },
      sessionPresentation: {
        titles: zh
          ? ["整理商品内容", "核验原始素材", "复核发布记录"]
          : ["Organize product content", "Check source materials", "Review publication records"],
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let mobileBrowser, store;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale, colorScheme: "dark" });
    const preferences = ({ locale }) => {
      if (/^https?:$/.test(location.protocol)) {
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "aurora");
      }
    };
    await context.addInitScript(preferences, { locale });
    await app.signIn(context);
    const api = async (path, data, method = data === undefined ? "get" : "post") => {
      const response = await context.request[method](app.base + path, {
        ...(data === undefined ? {} : { data }),
        headers: { Origin: app.base },
      });
      assert.ok(response.ok(), `Demo API failed: ${method} ${path} (${response.status()})`);
      return response.json();
    };
    const bot = (await api("/api/bots", publishingConfig(locale))).bot;
    await api("/api/bots/" + bot.id, { active: false }, "patch");
    store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
    const hold = (task, status, reason = null, decision = null, extra = {}) => {
      Object.assign(task, { status, reason, decision, updatedAt: Date.now(), ...extra });
      store.db
        .query("UPDATE bot_tasks SET status=?,data=?,leaseUntil=? WHERE id=?")
        .run(status, JSON.stringify(task), Date.now() + 3600000, task.id);
      return task;
    };
    const guard = store.submit(bot, publishingRequest("materials", locale, "ITEM-003"), "demo-running").task;
    hold(guard, "running");
    // The simulated active lease blocks this Bot's queue, including callback retries.
    await api("/api/bots/" + bot.id, { active: true }, "patch");
    const issued = await api("/api/bots/keys", {
      name: zh ? "企业作业系统调用方" : "Enterprise job caller",
      days: 30,
      botIds: [bot.id],
    });
    const submit = async (source) => {
      const facts = JSON.parse(source.input.text);
      const lines = zh
        ? [
            `作业 ${facts.jobId} · 商品 ${facts.productId} · 文案 ${facts.draftVersion}`,
            `商品：${facts.product}；素材包：${facts.assets.bundleId} / ${facts.sourceVersion}`,
            "已核验：100%聚酯纤维；M码样衣260g；双侧口袋；S–XL；按洗标30°C轻柔机洗。",
            "图片使用许可已记录。价格、库存与发布目标由企业系统管理。",
          ]
        : [
            `Job ${facts.jobId} · Product ${facts.productId} · Draft ${facts.draftVersion}`,
            `Product: ${facts.product}; bundle: ${facts.assets.bundleId} / ${facts.sourceVersion}`,
            "Verified: 100% polyester; 260 g size-M sample; two pockets; sizes S–XL; gentle wash at 30°C per label.",
            "Image-use permission is recorded. Price, inventory and destination remain enterprise-managed.",
          ];
      if (facts.unsupportedClaim)
        lines.push(
          zh
            ? "待复核：防水表述没有检测报告，当前版本未获发布审批。"
            : "Review required: waterproof wording has no test report; this revision is not approved for publication.",
        );
      if (facts.approvalRef)
        lines.push((zh ? "审批与产物：" : "Approval and artifact: ") + facts.approvalRef + " / " + facts.artifactRef);
      if (facts.approvedContent)
        lines.push((zh ? "已审批详情：" : "Approved details: ") + facts.approvedContent.description);
      if (facts.listingReceipt)
        lines.push(
          (zh ? "企业回执：" : "Enterprise receipt: ") +
            facts.listingReceipt.receiptRef +
            " / " +
            facts.listingReceipt.listingId +
            " / published / v4",
        );
      const request = { ...source, input: { ...source.input, text: lines.join("\n") } };
      const options = {
        data: request,
        headers: { Authorization: "Bearer " + issued.secret, "Idempotency-Key": request.externalTaskId },
      };
      const response = await context.request.post(app.base + "/api/v1/bots/" + bot.code + "/tasks", options);
      assert.equal(response.status(), 202);
      const result = await response.json();
      const replay = await context.request.post(app.base + "/api/v1/bots/" + bot.code + "/tasks", options);
      assert.equal(replay.status(), 200);
      assert.equal((await replay.json()).duplicate, true);
      return result.task;
    };
    const tasks = {};
    for (const stage of ["materials", "theme", "copy", "review"]) {
      const request = publishingRequest(stage, locale),
        task = await submit(request);
      tasks[stage] = task;
      if (stage === "review") {
        hold(task, "review", publishingOutcome(stage, locale), "review", {
          callbackStatus: "not-required",
          review: {
            id: "review-draft-v3",
            question: zh
              ? "文案中的防水表述没有检测依据，应如何处理？"
              : "The waterproof wording has no test evidence. How should this draft proceed?",
            options: [
              {
                id: "revise",
                label: zh ? "退回修订，移除无依据表述" : "Return for revision; remove the unsupported claim",
                actionId: "return_for_revision",
              },
              { id: "wait", label: zh ? "等待供应商补充资料" : "Wait for supporting supplier information" },
            ],
          },
        });
      } else
        hold(task, "completed", publishingOutcome(stage, locale), "save_stage", {
          decisionLabel: request.actions[0].label,
          callbackStatus: "succeeded",
        });
      store.event(task.id, "running", "Processing started");
      store.event(task.id, "decision", publishingOutcome(stage, locale));
    }
    const failed = await submit(publishingRequest("theme", locale, "ITEM-002"));
    hold(
      failed,
      "callback_failed",
      zh
        ? "阶段产物已完成，企业接口临时不可用。核对接收台账后可使用同一幂等标识重试。"
        : "The stage result is ready, but the enterprise endpoint is temporarily unavailable. Check its receipt ledger before retrying with the same idempotency identity.",
      "save_stage",
      { callbackStatus: "failed", decisionLabel: publishingRequest("theme", locale).actions[0].label },
    );
    store.event(failed.id, "callback_response", "HTTP 503; callback_failed; accepted=false");
    await submit(publishingRequest("materials", locale, "ITEM-004"));
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = async (target, name) => {
      await target.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await target.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      });
      assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.equal(await target.evaluate(() => document.documentElement.dataset.appearance), "aurora");
      const file = `bot-usecase-${name}-${locale}.webp`;
      await sharp(await target.screenshot())
        .webp({ quality: 84 })
        .toFile(resolve(output, file));
      captures.push({ file, locale, viewport: target.viewportSize(), theme: "aurora", fictionalData: true });
    };
    await page.goto(app.base + "/bots");
    await page.locator(`[data-detail="${tasks.review.id}"]`).waitFor();
    await page.locator('a[href="/settings/bots"]').first().click();
    await page.locator('[data-settings-page="general-settings"]').click();
    await page.locator("#themeSelect").selectOption("aurora");
    await page.locator('[data-settings-page="bots"]').click();
    const row = page.locator(".bot-config-row").filter({ hasText: bot.code });
    await row.locator("[data-edit]").click();
    const editor = page.locator(".bot-editor-dialog[open]");
    await editor.locator('[name="pf-bot-instructions"]').waitFor();
    await editor.locator('[name="pf-bot-hosts"]').scrollIntoViewIfNeeded();
    await capture(page, "config");
    await page.keyboard.press("Escape");
    await page.locator('[data-tab="keys"]').click();
    await page.locator("[data-issue-key]").click();
    const key = page.locator("dialog.bot-dialog[open]");
    await key.locator('[name="pf-bot-name"]').fill(zh ? "企业作业系统调用方" : "Enterprise job caller");
    await key.locator('[name="pf-bot-bot"]').check();
    await key.locator('[name="pf-bot-days"]').fill("30");
    assert.equal(await key.locator("[data-key]").count(), 0);
    await capture(page, "keys");
    await page.keyboard.press("Escape");
    await page.goto(app.base + "/bots");
    await page.locator(`[data-detail="${tasks.review.id}"]`).waitFor();
    await capture(page, "queue");
    await page.locator(`[data-detail="${tasks.review.id}"]`).click();
    const review = page.locator("dialog.bot-detail[open]");
    await review.locator('[name="pf-bot-review-option"][value="revise"]').check();
    await capture(page, "review");
    page.once("dialog", (dialog) => dialog.accept());
    await review.locator("[data-bot-review-submit]").click();
    await review.waitFor({ state: "detached" });
    const reviewed = (await api("/api/bots/tasks/" + tasks.review.id)).task;
    assert.equal(reviewed.reviewHistory.at(-1).answer.optionId, "revise");
    hold(
      reviewed,
      "completed",
      zh
        ? "v3 已退回修订。企业系统移除无依据表述，生成独立 v4 并完成审批后，才可提交发布任务。"
        : "v3 was returned. The enterprise system creates a separate corrected v4 and records approval before submitting a publication task.",
      "return_for_revision",
      { callbackStatus: "succeeded" },
    );
    const published = await submit(publishingRequest("publish", locale));
    hold(published, "completed", publishingOutcome("publish", locale), "publish_listing", {
      decisionLabel: publishingRequest("publish", locale).actions[0].label,
      callbackStatus: "succeeded",
    });
    for (const [kind, detail] of [
      ["running", "Processing started"],
      ["decision", publishingOutcome("publish", locale)],
      ["callback_dispatch", "POST https://jobs.enterprise.example/bot-results/accept"],
      ["callback_response", "HTTP 202; callback_succeeded; accepted=true; publication job durably queued"],
    ])
      store.event(published.id, kind, detail);
    const receipt = await submit(publishingRequest("receipt", locale));
    hold(receipt, "completed", publishingOutcome("receipt", locale), "complete", { callbackStatus: "not-required" });
    store.event(receipt.id, "decision", publishingOutcome("receipt", locale));
    await page.reload();
    await page.locator(`[data-detail="${published.id}"]`).click();
    await page.locator("dialog.bot-detail[open]").waitFor();
    await capture(page, "callback");
    await page.keyboard.press("Escape");
    await page.locator(`[data-detail="${receipt.id}"]`).click();
    await page.locator("dialog.bot-detail[open]").waitFor();
    await capture(page, "result");
    mobileBrowser = await webkit.launch({ headless: true });
    const mobile = await mobileBrowser.newContext({
      viewport: { width: 390, height: 844 },
      locale,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    });
    await mobile.addInitScript(preferences, { locale });
    await app.signIn(mobile);
    const mobilePage = await mobile.newPage();
    mobilePage.on("pageerror", (error) => errors.push(error.message));
    await mobilePage.goto(app.base + "/bots");
    await mobilePage.locator(`[data-detail="${receipt.id}"]`).waitFor();
    await capture(mobilePage, "mobile");
    assert.deepEqual(errors, []);
    assert.equal(app.calls().filter((call) => call.method === "turn/start").length, 0);
    assert.equal(store.task(bot.owner, guard.id).status, "running");
    await api("/api/bots/keys/" + issued.key.id, undefined, "delete");
    await mobile.close();
    await context.close();
  } finally {
    store?.close();
    await mobileBrowser?.close();
    await browser.close();
    await app.dispose();
  }
}
await writeFile(
  resolve(output, "bot-usecase-captures.json"),
  JSON.stringify({ simulatedTaskOutcomes: true, productionPublishing: false, captures }, null, 2) + "\n",
);
console.log(
  `Captured ${captures.length} dark-theme Bot views; authenticated submission, idempotent replay and human review exercised without external dispatch.`,
);
