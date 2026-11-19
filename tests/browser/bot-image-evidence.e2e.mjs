import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { BotStore } from "../../src/server/bots/store.js";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/pim-image-gate/browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture();
const results = [];
try {
  for (const [engine, width, locale, expected] of [
    [chromium, 1440, "en", "Image confirmation could not be completed"],
    [webkit, 390, "zh-CN", "图片二次确认未完成"],
    [chromium, 1440, "zh-HK", "圖片二次確認未完成"],
    [webkit, 320, "zh-TW", "圖片二次確認未完成"],
  ]) {
    if (process.env.PANDA_BOT_IMAGE_LOCALE && locale !== process.env.PANDA_BOT_IMAGE_LOCALE) continue;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", { data: { driver: "sqlite" } });
      const bot = (
        await (
          await context.request.post(app.base + "/api/bots", {
            data: {
              name: "Image review " + locale,
              code: "images-" + locale.toLowerCase(),
              callbackHosts: ["callback.example"],
            },
          })
        ).json()
      ).bot;
      await context.request.patch(app.base + "/api/bots/" + bot.id, { data: { active: false } });
      const key = (
        await (
          await context.request.post(app.base + "/api/bots/keys", {
            data: { name: "Local fixture", botIds: [bot.id], days: 1 },
          })
        ).json()
      ).secret;
      const task = (
        await (
          await context.request.post(app.base + "/api/v1/bots/" + bot.code + "/tasks", {
            headers: { authorization: "Bearer " + key, "idempotency-key": "image-" + locale },
            data: {
              externalTaskId: "image-" + locale,
              title: "Image confirmation",
              instructions: "Reject only after checking images",
              input: { text: "A shoe-shaped pin", images: ["https://assets.example/pin.jpg"] },
              callbacks: {
                discard: { url: "https://callback.example/reject", method: "POST", body: {} },
              },
            },
          })
        ).json()
      ).task;
      const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
      try {
        task.status = "review";
        task.reason = "imageConfirmationUnavailable";
        task.review = {
          id: "review-" + locale,
          question: "imageConfirmationUnavailable",
          options: [
            { id: "supply", label: "Provide clearer product evidence" },
            { id: "retry", label: "Provide accessible images" },
          ],
        };
        store.db
          .query("UPDATE bot_tasks SET status=?,data=? WHERE id=?")
          .run(task.status, JSON.stringify(task), task.id);
        store.event(task.id, "images_failed", "imageConfirmationUnavailable");
      } finally {
        store.close();
      }
      await context.addInitScript((locale) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/bots/tasks");
      await page.locator(`[data-detail="${task.id}"]`).click();
      const dialog = page.locator("dialog.bot-detail[open]");
      await dialog.locator(".bot-review-question").filter({ hasText: expected }).waitFor();
      assert(await dialog.isVisible());
      const rects = await dialog.evaluate((el) => {
        const rect = (n) => {
          const r = n.getBoundingClientRect(),
            s = getComputedStyle(n);
          return {
            y: r.y,
            h: r.height,
            display: s.display,
            position: s.position,
            padding: s.padding,
            margin: s.margin,
          };
        };
        return {
          scroll: el.scrollTop,
          dialog: rect(el),
          header: rect(el.querySelector("header")),
          title: rect(el.querySelector("h2")),
          wrap: rect(el.querySelector("header>div")),
        };
      });
      await writeFile(`${out}/layout-${locale}.json`, JSON.stringify(rects, null, 2));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/blocked-${locale}-${width}.png` });
      await dialog.locator('[name="pf-bot-review-option"][value=retry]').check();
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/tasks/" + task.id + "/review") && r.request().method() === "POST",
      );
      await dialog.locator("[data-bot-review-submit]").click();
      assert.equal((await response).status(), 200);
      results.push({ locale, width, failedImageReview: true, continueWithNewEvidence: true, errors });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
