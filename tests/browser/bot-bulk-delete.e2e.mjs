import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const out = ".artifacts/bot-bulk-delete/screens",
  records = [];
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1600, "en"],
  [webkit, 430, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture({ startupTimeoutMs: 60000 }),
    browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
  let store;
  try {
    await app.signIn(context);
    const response = await context.request.post(app.base + "/api/bots", {
      headers: { Origin: app.base },
      data: { code: "bulk-delete", name: "Evidence assistant" },
    });
    assert.ok(response.ok());
    const { bot } = await response.json();
    await context.request.patch(app.base + "/api/bots/" + bot.id, {
      headers: { Origin: app.base },
      data: { active: false },
    });
    store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
    const count = locale === "en" ? 505 : 55,
      tasks = [];
    for (let i = 0; i < count + 1; i++) {
      const task = store.submit(
        bot,
        {
          title: (i < count ? "Delete cohort " : "Preserved ") + i,
          externalTaskId: "product-" + i,
          instructions: "Inspect evidence",
          input: { text: "Independent request", images: [] },
        },
        "instance-" + i,
      ).task;
      task.status = i === 0 ? "callback_unknown" : "completed";
      task.decision = i === 0 ? "discard" : "complete";
      store.db.query("UPDATE bot_tasks SET status=?,data=? WHERE id=?").run(task.status, JSON.stringify(task), task.id);
      tasks.push(task);
    }
    const page = await context.newPage(),
      errors = [],
      posts = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(20000);
    await page.goto(app.base + "/bots/tasks");
    await page.locator("[data-bot-select]").selectOption(bot.id);
    await page.locator("[data-delete-open]").click();
    await page.locator("[data-delete-page]").check();
    assert.equal(await page.locator("[data-delete-select]:checked").count(), 50);
    const firstSelected = await page.locator("[data-delete-select]").first().getAttribute("data-delete-select");
    await page.locator("[data-page-next]").click();
    await page.waitForFunction(
      (id) => document.querySelector("[data-delete-select]")?.getAttribute("data-delete-select") !== id,
      firstSelected,
    );
    await page.locator("[data-delete-select]").first().check();
    await page.locator("[data-page-prev]").click();
    await page.locator(`[data-delete-select="${firstSelected}"]:checked`).waitFor();
    await page.locator("[data-delete-selected]").click();
    const dialog = page.locator(".bot-dialog[open]");
    await dialog.waitFor();
    await dialog.locator("[data-delete-cancel]").click();
    assert.equal(store.task(bot.owner, tasks[1].id).status, "completed");
    await page.locator("[data-bot-search]").fill("Delete cohort");
    await page.waitForTimeout(500);
    await page.locator("[data-delete-open]").click();
    await page.locator("[data-delete-filtered]").click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(String(count)));
    assert.ok((await dialog.boundingBox()).width <= width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(out, `confirm-${locale}-${width}.png`) });
    let lost = false;
    await page.route("**/api/bots/tasks/delete", async (route) => {
      posts.push(route.request().postDataJSON());
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await dialog.locator("[data-delete-submit]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-bot-dialog-notice]")?.textContent.length > 10 &&
        document.querySelector(".bot-dialog[open]")?.getAttribute("aria-busy") === "false",
    );
    await dialog.locator("[data-delete-submit]").click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(posts[0], posts[1]);
    assert.ok(posts.every((p) => p.taskIds.length <= 500));
    assert.equal(posts.length, locale === "en" ? 3 : 2);
    assert.equal(store.task(bot.owner, tasks[0].id).status, "callback_unknown");
    assert.equal(store.task(bot.owner, tasks[count].id).status, "completed");
    for (const task of tasks.slice(1, count)) assert.throws(() => store.task(bot.owner, task.id));
    const old = {
      title: "Delete cohort 1",
      externalTaskId: "product-1",
      instructions: "Inspect evidence",
      input: { text: "Independent request", images: [] },
    };
    assert.throws(() => store.submit(bot, old, "instance-1"));
    assert.ok(store.submit(bot, old, "new-instance-1").task.id);
    await page.screenshot({ path: join(out, `after-${locale}-${width}.png`) });
    assert.deepEqual(errors, []);
    records.push({ locale, width, count, lostAckReplay: true, callbackPreserved: true, newInstance: true });
  } finally {
    store?.close();
    await context.close();
    await browser.close();
    await app.stop();
  }
}
await writeFile(join(out, "verified.json"), JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
