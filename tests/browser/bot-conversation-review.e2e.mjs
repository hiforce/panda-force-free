import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
const root = process.cwd(),
  out = join(root, ".artifacts/bot-conversation-review");
await mkdir(out, { recursive: true });
const entry = join(out, "entry.ts");
await Bun.write(
  entry,
  `import {openBotTask} from ${JSON.stringify(join(root, "src/client/bots/task-detail.ts"))};import {getBrowserI18n,setOpaqueText} from ${JSON.stringify(join(root, "src/client/i18n.js"))};const i18n=getBrowserI18n();await i18n.ready;globalThis.__reviewI18n=i18n;const host=document.querySelector('main');const context={t:i18n.t,async api(path='',method='GET',body){const response=await fetch('/api/bots'+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw Error(value.error?.code||'requestFailed');return value;},async execute(work){try{await work();}catch{this.notice(this.t('cli.botError'));}},notice(message){setOpaqueText(document.querySelector('[data-bot-dialog-notice]')||document.querySelector('[data-notice]'),message);},async reload(){}};for(const button of document.querySelectorAll('[data-open]'))button.onclick=()=>context.execute(()=>openBotTask(host,context,button.dataset.open,button));`,
);
const build = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  outdir: out,
  naming: "review-runtime.js",
  plugins: [
    {
      name: "shared-review-ui",
      setup(build) {
        build.onResolve({ filter: /i18n\.js$/ }, (args) =>
          resolve(args.resolveDir, args.path) === join(root, "src/client/i18n.js")
            ? { path: "/i18n.js", external: true }
            : undefined,
        );
      },
    },
  ],
});
assert.equal(build.success, true);
const styles = ["style", "appearance", "workbench", "workbench-forms", "workbench-layout", "bots"];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((name) => `<link rel="stylesheet" href="/${name}.css">`).join("")}<script type="module" src="/review-runtime.js"></script></head><body><main class="bot-workspace" style="padding:var(--pf-page-padding) var(--pf-page-padding-inline)"><h1>Bot review fixture</h1><p data-notice role="status"></p>${["dynamic", "legacy", "stale", "unknown", "retry", "callback", "complete"].map((id) => `<button class="wb-button" data-open="${id}">${id}</button>`).join("")}</main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/review-runtime.js") return new Response(Bun.file(join(out, "review-runtime.js")));
    if (
      styles.some((name) => path === `/${name}.css`) ||
      ["/i18n.js", "/http-client.js"].includes(path) ||
      /^\/locales\/(en|zh-CN|zh-HK|zh-TW)\.json$/.test(path)
    )
      return new Response(Bun.file(join(root, "public", path.slice(1))));
    return new Response("Not found", { status: 404 });
  },
});
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1440, "zh-HK"],
    [webkit, 390, "zh-TW"],
  ].filter(
    (entry) =>
      !process.env.PANDA_BOT_REVIEW_LOCALES || process.env.PANDA_BOT_REVIEW_LOCALES.split(",").includes(entry[2]),
  )) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    try {
      await context.addInitScript((locale) => localStorage.setItem("panda-force-locale", locale), locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const make = (id) => ({
        id,
        botId: "bot",
        owner: "owner",
        externalTaskId: id,
        title: "Conversation-specific review",
        status: "review",
        decision: "review",
        reason: "A source is missing; the conversation needs your direction.",
        input: {
          externalTaskId: id,
          instructions: "Continue from the original conversation.",
          input: { text: "Unchanged caller content <script>window.invalid=true</script>", images: [] },
          actions: [
            {
              id: "publish",
              label: "Send current version",
              callback: {
                url: "https://callback.example.com/publish",
                method: "POST",
                body: { id },
                success: { path: "ok", equals: true },
              },
            },
            {
              id: "archive",
              label: "Archive elsewhere",
              callback: { url: "https://other.example.com/private", method: "POST", body: { id } },
            },
          ],
        },
        review: {
          id: "review-" + id,
          question: "Which source should guide this task? <keep this text>",
          options: [
            { id: "wait-source", label: "Wait for a verified source" },
            {
              id: "send-current",
              label: "Use the current version after checking the conversation",
              actionId: "publish",
            },
          ],
        },
        createdAt: Date.now(),
        updatedAt: 1700000000000,
        sessionId: null,
        runId: null,
      });
      const tasks = Object.fromEntries(
        ["dynamic", "legacy", "stale", "unknown", "retry", "callback", "complete"].map((id) => [id, make(id)]),
      );
      delete tasks.legacy.review;
      delete tasks.legacy.input.actions;
      tasks.retry.status = "callback_failed";
      tasks.retry.decision = "publish";
      tasks.retry.decisionLabel = "Send current version";
      delete tasks.retry.review;
      tasks.complete.status = "completed";
      tasks.complete.decision = "complete";
      delete tasks.complete.review;
      delete tasks.complete.input.actions;
      const submissions = {},
        counts = {};
      let unknownReads = false;
      const answer = (task, body) => {
        task.reviewHistory = [
          {
            ...(task.review || { id: body.reviewId, question: task.reason, options: [] }),
            answer: {
              ...(body.optionId ? { optionId: body.optionId } : {}),
              ...(body.message ? { message: body.message } : {}),
              at: Date.now(),
            },
          },
        ];
        task.status = "queued";
        task.decision = null;
        delete task.review;
      };
      await page.route("**/api/bots/tasks/**", async (route) => {
        const req = route.request(),
          match = /\/tasks\/([^/]+)(?:\/(review|retry))?$/.exec(new URL(req.url()).pathname),
          id = match[1],
          action = match[2],
          task = tasks[id];
        const json = (value, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (!action) {
          if (id === "unknown" && unknownReads) return route.abort("failed");
          return json({ task, events: [] });
        }
        counts[id] = (counts[id] || 0) + 1;
        const body = req.postDataJSON();
        (submissions[id] ??= []).push(body);
        await new Promise((resolve) => setTimeout(resolve, 220));
        if (action === "retry") {
          assert.deepEqual(body, { confirm: true });
          task.status = "queued";
          return json({ task });
        }
        assert.equal(body.reviewId, task.review?.id || "legacy:" + id + ":" + task.updatedAt);
        assert.equal("decision" in body, false);
        if (id === "dynamic" && counts[id] === 1) return json({ error: { code: "invalidReview" } }, 400);
        if (id === "stale") {
          answer(task, {
            reviewId: body.reviewId,
            optionId: "send-current",
            message: "Another administrator answered differently",
          });
          task.status = "review";
          task.review = {
            id: "newer-question",
            question: "A newer conversation question",
            options: [
              { id: "continue-later", label: "Continue later" },
              { id: "check-again", label: "Check again" },
            ],
          };
          return route.abort("failed");
        }
        answer(task, body);
        if (id === "unknown") {
          unknownReads = true;
          return route.abort("failed");
        }
        if (id === "dynamic") return route.abort("failed");
        return json({ task });
      });
      await page.goto(server.url.href);
      await page.locator('[data-open="dynamic"]').click();
      const dialog = page.locator("dialog.bot-detail[open]");
      await dialog.waitFor();
      assert.equal(await dialog.locator('input[type="radio"]').count(), 2);
      assert.equal(await dialog.locator('input[type="radio"]:checked').count(), 0);
      assert.equal(await dialog.locator('[data-action="keep"],[data-action="discard"]').count(), 0);
      assert.equal(
        await dialog
          .locator("[data-bot-review]")
          .innerText()
          .then((s) => s.includes("<keep this text>")),
        true,
      );
      await dialog.locator('input[value="wait-source"]').focus();
      await page.keyboard.press("Space");
      const message = dialog.locator('[name="pf-bot-review-message"]'),
        submit = dialog.locator("[data-bot-review-submit]");
      await message.fill("Keep my explanation and selected choice.");
      await page.screenshot({ path: join(out, `question-${locale}-${width}.png`) });
      await submit.click();
      await page.waitForTimeout(50);
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await dialog.getAttribute("aria-busy"), "true");
      await page.waitForFunction(
        () => document.querySelector('dialog[data-pending="false"] [data-bot-dialog-notice]')?.textContent.length > 0,
      );
      assert.equal(await message.inputValue(), "Keep my explanation and selected choice.");
      assert.equal(await dialog.locator('input[value="wait-source"]').isChecked(), true);
      assert.equal(await submit.evaluate((el) => document.activeElement === el), true);
      const other = locale === "en" ? "zh-TW" : "en";
      await page.evaluate(async (value) => globalThis.__reviewI18n.setPreference(value), other);
      assert.equal(await message.inputValue(), "Keep my explanation and selected choice.");
      await page.evaluate(async (value) => globalThis.__reviewI18n.setPreference(value), locale);
      await page.screenshot({ path: join(out, `failure-${locale}-${width}.png`) });
      await dialog.locator('input[value="send-current"]').check();
      await message.fill("");
      await dialog.locator(".bot-action-callback summary").click();
      assert.match(await dialog.innerText(), /callback\.example\.com\/publish/);
      assert.equal((await dialog.innerText()).includes("other.example.com"), false);
      await message.fill("Check the newest source before any external call.");
      assert.equal(await dialog.locator(".bot-action-callback").count(), 0);
      await submit.click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(counts.dynamic, 2);
      assert.deepEqual(submissions.dynamic[1], {
        reviewId: "review-dynamic",
        optionId: "send-current",
        message: "Check the newest source before any external call.",
      });
      await page.locator('[data-open="legacy"]').click();
      await dialog.waitFor();
      assert.equal(await dialog.locator('input[type="radio"]').count(), 0);
      await dialog.locator('[name="pf-bot-review-message"]').fill("Please compare the remaining evidence.");
      await page.screenshot({ path: join(out, `legacy-${locale}-${width}.png`) });
      await dialog.locator("[data-bot-review-submit]").click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(submissions.legacy[0].reviewId, "legacy:legacy:1700000000000");
      await page.locator('[data-open="stale"]').click();
      await dialog.waitFor();
      await dialog.locator('input[value="wait-source"]').check();
      await dialog
        .locator('[name="pf-bot-review-message"]')
        .fill("My original draft must survive another administrator.");
      await dialog.locator("[data-bot-review-submit]").click();
      await page.waitForFunction(() => document.querySelector('[name="pf-bot-review-message"]')?.readOnly === true);
      assert.equal(
        await dialog.locator('[name="pf-bot-review-message"]').inputValue(),
        "My original draft must survive another administrator.",
      );
      assert.equal(counts.stale, 1);
      assert.equal(
        (await dialog.innerText()).includes(locale === "en" ? "Your reply was recorded" : "回复已记录"),
        false,
      );
      await page.screenshot({ path: join(out, `stale-${locale}-${width}.png`) });
      await dialog.locator("[data-bot-review-submit]").click();
      await dialog.locator(".bot-review-question").filter({ hasText: "A newer conversation question" }).waitFor();
      assert.equal(await dialog.locator('[name="pf-bot-review-message"]').inputValue(), "");
      await dialog.locator("[data-close]").click();
      await page.locator('[data-open="unknown"]').click();
      await dialog.waitFor();
      await dialog.locator('[name="pf-bot-review-message"]').fill("The original frozen answer.");
      await dialog.locator("[data-bot-review-submit]").click();
      await page.waitForFunction(() => document.querySelector('[name="pf-bot-review-message"]')?.readOnly === true);
      assert.equal(await dialog.locator('input[type="radio"]').first().isDisabled(), true);
      await page.screenshot({ path: join(out, `unknown-${locale}-${width}.png`) });
      unknownReads = false;
      await dialog.locator("[data-bot-review-submit]").click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(counts.unknown, 1);
      await page.locator('[data-open="retry"]').click();
      await dialog.waitFor();
      await dialog.locator(".bot-action-callback summary").click();
      assert.equal((await dialog.innerText()).includes("other.example.com"), false);
      await page.screenshot({ path: join(out, `retry-${locale}-${width}.png`) });
      let confirm = "";
      page.once("dialog", async (prompt) => {
        confirm = prompt.message();
        await prompt.accept();
      });
      await dialog.locator('[data-action="retry"]').click();
      await dialog.waitFor({ state: "detached" });
      assert.match(confirm, /Send current version/);
      assert.equal(counts.retry, 1);
      await page.locator('[data-open="callback"]').click();
      await dialog.waitFor();
      await dialog.locator('input[value="send-current"]').check();
      let callbackConfirm = "";
      page.once("dialog", async (prompt) => {
        callbackConfirm = prompt.message();
        await prompt.dismiss();
      });
      await dialog.locator("[data-bot-review-submit]").click();
      assert.match(callbackConfirm, /Send current version/);
      assert.equal(counts.callback, undefined);
      assert.equal(await dialog.locator('input[value="send-current"]').isChecked(), true);
      await dialog.locator(".bot-action-callback summary").click();
      await page.screenshot({ path: join(out, `callback-${locale}-${width}.png`) });
      page.once("dialog", async (prompt) => {
        await prompt.accept();
      });
      await dialog.locator("[data-bot-review-submit]").click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(counts.callback, 1);
      await page.locator('[data-open="complete"]').click();
      await dialog.waitFor();
      assert.equal(await dialog.locator("[data-bot-review]").count(), 0);
      assert.equal(await dialog.locator('[data-status="finished"]').count(), 1);
      await page.screenshot({ path: join(out, `complete-${locale}-${width}.png`) });
      await dialog.locator("[data-close]").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.evaluate(() => typeof window.invalid), "undefined");
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        dynamicOptions: true,
        noFixedReviewActions: true,
        legacyContinuation: true,
        keyboardAndFailureDraftPreserved: true,
        languageSwitchDraftPreserved: true,
        callbackDetailsScoped: true,
        callbackRetryUsesPriorDecision: true,
        declaredCallbackConfirmedByName: true,
        staleConflictPreserved: true,
        unknownReplyReconciled: true,
        counts,
        errors,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    join(out, process.env.PANDA_BOT_REVIEW_LOCALES ? "browser-layout-results.json" : "browser-results.json"),
    JSON.stringify(records, null, 2),
  );
  console.log(JSON.stringify(records));
} finally {
  server.stop(true);
}
