import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const out = ".artifacts/bot-bulk-retry/screens",
  records = [];
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1600, "en"],
  [webkit, 430, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture(),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
  try {
    await app.signIn(context);
    await context.addInitScript(() => {
      if (window === window.top) localStorage.setItem("panda-force-theme", "aurora");
    });
    const response = await context.request.post(app.base + "/api/bots", {
      headers: { Origin: app.base },
      data: { code: "bulk-retry", name: "Evidence assistant" },
    });
    assert.ok(response.ok(), "Bot create: " + response.status() + " " + (await response.text()));
    const { bot } = await response.json();
    await context.request.patch(app.base + "/api/bots/" + bot.id, {
      headers: { Origin: app.base },
      data: { active: false },
    });
    const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite")),
      tasks = [],
      failedCount = locale === "en" ? 125 : 75;
    const change = (task, status, decision, failure) => {
      Object.assign(task, {
        status,
        decision,
        failure,
        reason: failure ? "No validated decision was received" : "Current evidence needs review",
      });
      store.db.query("UPDATE bot_tasks SET status=?,data=? WHERE id=?").run(status, JSON.stringify(task), task.id);
    };
    try {
      for (let index = 0; index < failedCount + 3; index++) {
        const task = store.submit(
          bot,
          {
            title: `Evidence batch ${index + 1}`,
            externalTaskId: "evidence-" + index,
            instructions: "Inspect current evidence",
            input: { text: "An independent evidence request", images: [] },
          },
          "bulk-" + index,
        ).task;
        change(
          task,
          index < failedCount + 1 ? "review" : index === failedCount + 1 ? "callback_failed" : "completed",
          index < failedCount
            ? null
            : index === failedCount
              ? "review"
              : index === failedCount + 1
                ? "discard"
                : "complete",
          index < failedCount ? "execution" : undefined,
        );
        tasks.push(task);
      }
      const page = await context.newPage(),
        errors = [],
        posts = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") console.error("Browser console:", msg.text());
      });
      page.on("response", (response) => {
        if (response.status() >= 400) console.error("HTTP", response.status(), response.url());
      });
      await page.goto(app.base + "/bots");
      try {
        await page.locator(".bot-task-row").first().waitFor();
      } catch (error) {
        console.error(
          JSON.stringify({ errors, url: page.url(), body: (await page.locator("body").innerText()).slice(-5000) }),
        );
        await page.screenshot({ path: join(out, "failure.png") });
        throw error;
      }
      await page.locator("[data-bot-select]").selectOption(bot.id);
      await page.locator("[data-filter]").selectOption("attention");
      await page.waitForFunction(() => document.querySelectorAll("[data-retry-select]").length > 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
      await page.screenshot({ path: join(out, `initial-${locale}-${width}.png`) });
      assert.ok((await page.locator("[data-retry-select]").first().locator("..").boundingBox()).height >= 44);
      await page.locator("[data-retry-select]").first().focus();
      await page.keyboard.press("Space");
      const selected = await page.locator("[data-retry-select]:checked").getAttribute("data-retry-select");
      const choose = async (language) => {
        await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
        if (width < 768) await page.locator('[data-chrome-action="menu"][data-value="language"]').click();
        await page.locator(`[data-chrome-action="locale"][data-value="${language}"]`).click();
        await page.waitForFunction((language) => document.documentElement.lang === language, language);
        await page.locator("#workbenchPreferences").waitFor({ state: "hidden" });
      };
      await choose(locale === "en" ? "zh-CN" : "en");
      await page.locator(`[data-retry-select="${selected}"]:checked`).waitFor();
      await choose(locale);
      await page.locator(`[data-retry-select="${selected}"]:checked`).waitFor();
      await page.locator("[data-recovery-action=selected]").click();
      const dialog = page.locator(".bot-dialog[open]");
      await dialog.waitFor();
      assert.match(await dialog.locator("[data-retry-confirm]").innerText(), /1/);
      await dialog.locator("[data-retry-cancel]").click();
      assert.equal(store.task(bot.owner, selected).status, "review");
      await page.locator("[data-recovery-action=selected]").click();
      let lost = false;
      await page.route("**/api/bots/tasks/retry-failed", async (route) => {
        posts.push(route.request().postDataJSON());
        if (!lost) {
          lost = true;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await dialog.locator("[data-retry-confirm-submit]").click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-bot-dialog-notice]")?.textContent.length > 10 &&
          document.querySelector(".bot-dialog[open]")?.getAttribute("aria-busy") === "false",
      );
      await dialog.locator("[data-retry-confirm-submit]").click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(posts[0], posts[1]);
      assert.equal(store.task(bot.owner, selected).status, "queued");
      assert.equal(store.events(bot.owner, selected).filter((event) => event.kind === "resume").length, 1);
      await page.locator("[data-recovery-action=all]").click();
      await dialog.waitFor();
      assert.match(await dialog.locator("[data-retry-confirm]").innerText(), new RegExp(String(failedCount - 1)));
      assert.ok((await dialog.boundingBox()).width <= width);
      await page.screenshot({ path: join(out, `confirm-${locale}-${width}.png`) });
      const concurrent = tasks.find((task) => task.id !== selected && task.failure === "execution");
      change(concurrent, "completed", "complete", undefined);
      await dialog.locator("[data-retry-confirm-submit]").click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(posts[2].taskIds.length, failedCount - 1);
      assert.equal(new Set(posts[2].taskIds).size, failedCount - 1);
      const actual = tasks.map((task) => store.task(bot.owner, task.id));
      assert.equal(actual.filter((task) => task.status === "queued").length, failedCount - 1);
      assert.equal(actual[failedCount].status, "review");
      assert.equal(actual[failedCount + 1].status, "callback_failed");
      assert.equal(actual.filter((task) => task.status === "completed").length, 2);
      assert.equal(actual.length, failedCount + 3);
      await page.locator("[data-filter]").selectOption("progress");
      await page.waitForFunction(() => document.querySelectorAll(".bot-task-row").length === 50);
      assert.equal(await page.locator("[data-recovery-action=all]").isDisabled(), true);
      await page.screenshot({ path: join(out, `queued-${locale}-${width}.png`) });
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        originalTasks: failedCount + 3,
        queued: failedCount - 1,
        preservedHumanReviews: 1,
        preservedCallbacks: 1,
        lostAckReplay: true,
        errors,
      });
    } finally {
      store.close();
    }
  } finally {
    await context.close();
    await browser.close();
    await app.stop();
  }
}
await writeFile(join(out, "verified.json"), JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
