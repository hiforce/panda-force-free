import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const app = await createAppFixture(),
  out = process.env.PANDA_BOT_ACTION_ARTIFACTS || ".artifacts/bot-task-actions";
await mkdir(out, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: width === 1440 ? "light" : "dark",
      });
    try {
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      await api("/api/system/database/selection", { driver: "sqlite" });
      const bot = (
        await api("/api/bots", {
          name: "Local task cleanup " + width,
          code: "task-actions-" + width,
          callbackHosts: ["callback.example.com"],
        })
      ).bot;
      await api("/api/bots/" + bot.id, { active: false }, "patch");
      const keys = await api("/api/bots/keys", { name: "Test integration", botIds: [bot.id], days: 1 });
      const submit = async (name, callback = false) => {
        const response = await context.request.post(app.base + "/api/v1/bots/" + bot.code + "/tasks", {
          headers: { authorization: "Bearer " + keys.secret, "idempotency-key": name },
          data: {
            externalTaskId: name,
            instructions: "Review this sample",
            input: { text: "TEAM VISOR. Lightweight visor with a flexible strap.", images: [] },
            ...(callback
              ? {
                  callbacks: {
                    discard: { url: "https://callback.example.com/discard", method: "POST", body: { id: name } },
                  },
                }
              : {}),
          },
        });
        assert.equal(response.status(), 202);
        return (await response.json()).task;
      };
      const plain = await submit("local-record-" + width),
        blocked = await submit("blocked-callback-" + width, true),
        running = await submit("running-record-" + width);
      const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
      try {
        for (const task of [plain, blocked, running]) {
          task.status = task.id === running.id ? "running" : "review";
          if (task.id === blocked.id)
            task.review = {
              id: "conversation-" + task.id,
              question: "Send the caller's cleanup request or continue checking its context?",
              options: [
                { id: "send-cleanup", label: "Send the caller's cleanup request", actionId: "discard" },
                { id: "check-context", label: "Continue checking the original context" },
              ],
            };
          store.db
            .query("UPDATE bot_tasks SET status=?,data=?,leaseUntil=? WHERE id=?")
            .run(task.status, JSON.stringify(task), Date.now() + 600000, task.id);
        }
      } finally {
        store.close();
      }
      await api("/api/bots/" + bot.id, { callbackHosts: [] }, "patch");
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.base + "/bots");
      await page.locator(`[data-detail="${plain.id}"]`).click();
      const dialog = page.locator("dialog.bot-detail[open]");
      const bounds = await dialog.boundingBox();
      assert.ok(
        bounds && Math.abs(bounds.x + bounds.width / 2 - width / 2) <= 1 && bounds.y >= 0,
        "Task dialog must stay centered inside the viewport",
      );
      assert.equal(await dialog.locator('[data-action="discard"],[data-action="keep"]').count(), 0);
      assert.equal(await dialog.locator('[name="pf-bot-review-message"]').isEnabled(), true);
      assert.equal(await dialog.locator("[data-bot-review-submit]").isEnabled(), true);
      await page.screenshot({ path: join(out, "no-callback-" + width + ".png") });
      page.once("dialog", (d) => d.accept());
      const deleted = page.waitForResponse(
        (r) => r.url().endsWith("/api/bots/tasks/" + plain.id) && r.request().method() === "DELETE",
      );
      await dialog.locator("[data-delete-record]").click();
      assert.equal((await deleted).status(), 200);
      await dialog.waitFor({ state: "detached" });
      await page.locator(`[data-detail="${plain.id}"]`).waitFor({ state: "detached" });
      assert.equal((await context.request.get(app.base + "/api/bots/tasks/" + plain.id)).status(), 404);
      await page.locator(`[data-detail="${blocked.id}"]`).click();
      page.once("dialog", (d) => d.accept());
      const denied = page.waitForResponse(
        (r) => r.url().endsWith("/api/bots/tasks/" + blocked.id + "/review") && r.request().method() === "POST",
      );
      await dialog.locator('input[value="send-cleanup"]').check();
      await dialog.locator("[data-bot-review-submit]").click();
      assert.equal((await denied).status(), 403);
      await dialog
        .locator("[data-bot-dialog-notice]")
        .filter({ hasText: locale === "en" ? "not allowed" : "不在允许" })
        .waitFor();
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await dialog.locator("[data-bot-review-submit]").isEnabled(), true);
      assert.equal(await dialog.locator('input[value="send-cleanup"]').isChecked(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, "callback-feedback-" + width + ".png") });
      const continued = page.waitForResponse(
        (r) => r.url().endsWith("/api/bots/tasks/" + blocked.id + "/review") && r.request().method() === "POST",
      );
      await dialog.locator('input[value="check-context"]').check();
      await dialog
        .locator('[name="pf-bot-review-message"]')
        .fill("Check the source before calling any external interface.");
      await dialog.locator("[data-bot-review-submit]").click();
      assert.equal((await continued).status(), 200);
      await dialog.waitFor({ state: "detached" });
      await page
        .locator(`[data-detail="${blocked.id}"]`)
        .locator("..")
        .locator("..")
        .locator('[data-status="created"]')
        .waitFor();
      assert.equal(await page.locator(`[data-task-id="${blocked.id}"] [data-decision="pending"]`).count(), 1);
      page.once("dialog", (d) => d.accept());
      const deleteList = page.waitForResponse(
        (r) => r.url().endsWith("/api/bots/tasks/" + blocked.id) && r.request().method() === "DELETE",
      );
      if (width < 768) {
        await page.locator(`[data-detail="${blocked.id}"]`).click();
        await dialog.waitFor();
        await dialog.locator("[data-delete-record]").click();
      } else await page.locator(".bot-task-list").locator(`[data-delete-record="${blocked.id}"]`).click();
      assert.equal((await deleteList).status(), 200);
      assert.equal(
        await page.locator(".bot-task-list").locator(`[data-delete-record="${running.id}"]`).isDisabled(),
        true,
      );
      assert.equal((await context.request.delete(app.base + "/api/bots/tasks/" + running.id)).status(), 409);
      const replay = await context.request.post(app.base + "/api/v1/bots/" + bot.code + "/tasks", {
        headers: { authorization: "Bearer " + keys.secret, "idempotency-key": "local-record-" + width },
        data: {
          externalTaskId: "local-record-" + width,
          instructions: "Review this sample",
          input: { text: "TEAM VISOR. Lightweight visor with a flexible strap.", images: [] },
        },
      });
      assert.equal(replay.status(), 409);
      assert.equal((await replay.json()).error.code, "taskDeleted");
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        localDeletionFromDetails: true,
        localDeletionFromList: width >= 768,
        legacyTaskHasNeutralContinuation: true,
        errorInsideOpenDialog: true,
        continuationWorksAfterDeniedCallback: true,
        runningDeletionDenied: true,
        deletedSubmissionCannotReplay: true,
        realModelOrExternalCallbackInvoked: false,
      });
    } finally {
      await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: "wait" })));
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "result.json"), JSON.stringify({ passed: true, records }, null, 2) + "\n");
} finally {
  await app.dispose();
}
