import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const app = await createAppFixture(),
  out = ".artifacts/bot-capacity/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "zh-CN", "aurora"],
    [chromium, 1280, "en", "silk"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + "/api/bots" + path, { data });
        assert.ok(response.ok(), path + ":" + (await response.text()));
        return response.json();
      };
      const { bot } = await api("", {
        code: "compact-" + width,
        name: locale === "en" ? "Product reviewer" : "商品资料助理",
      });
      await api("/" + bot.id, { active: false }, "patch");
      const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
      try {
        store.db
          .transaction(() => {
            for (let index = 0; index < 125; index++) {
              const task = store.submit(
                bot,
                {
                  title: `【预处理】品牌: VANS 货号: VN${String(index).padStart(6, "0")} 批次: 20261113:vans.au.extra.cfs`,
                  externalTaskId: "pim-publish-" + index + "a".repeat(64),
                  instructions: "Review product facts",
                  input: { text: "Product facts and evidence belong in task details.", images: [] },
                },
                "compact-" + width + "-" + index,
              ).task;
              task.status = ["kept", "discarded", "running", "queued", "review"][index % 5];
              store.db
                .query("UPDATE bot_tasks SET status=?, data=?, leaseUntil=? WHERE id=?")
                .run(task.status, JSON.stringify(task), Date.now() + 600000, task.id);
            }
          })
          .immediate();
      } finally {
        store.close();
      }
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(12000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/bots");
      await page.locator(".bot-task-row").first().waitFor();
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/bots/queue?") && r.url().includes(bot.id)),
        page.locator("[data-bot-select]").selectOption(bot.id),
      ]);
      assert.equal(await page.locator(".bot-task-row").count(), 50);
      const geometry = await page.evaluate(() => {
        const box = (selector) => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          heading: box(".bot-queue-heading"),
          title: box(".bot-title-row"),
          actions: box(".bot-queue-heading > .bot-record-actions"),
          metrics: box(".bot-metrics"),
          firstMetric: box(".bot-metrics > button:first-child"),
          lastMetric: box(".bot-metrics > button:last-child"),
          row: box(".bot-task-row"),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      console.log("Compact geometry", width, JSON.stringify(geometry));
      await page.screenshot({ path: join(out, "tasks-" + width + ".png") });
      assert.equal(geometry.overflow, false);
      assert.ok(Math.abs(geometry.title.y - geometry.actions.y) <= 4, "Header must stay on one row");
      assert.ok(geometry.row.height <= (width < 768 ? 88 : 72), JSON.stringify(geometry));
      if (width < 768) {
        assert.equal(geometry.firstMetric.y, geometry.lastMetric.y, "All four filters share one row");
        assert.ok(
          Math.abs(geometry.lastMetric.x + geometry.lastMetric.width - geometry.metrics.x - geometry.metrics.width) < 2,
        );
        assert.ok(geometry.row.y <= 310, "The first task must remain near the top");
        assert.ok((await page.locator(".bot-row-open").first().boundingBox()).height >= 44);
      }
      console.log("Rendered compact queue", width, locale);
      const help = page.locator("[data-queue-help]");
      await help.focus();
      await page.keyboard.press("Enter");
      await page.locator(".bot-dialog[open]").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-queue-help"));
      console.log("Verified help focus", width);

      await page.locator("[data-page-next]").click();
      await page.waitForFunction(() => document.querySelector("[data-page-summary]")?.textContent.includes("51"));
      const search = page.locator("[data-bot-search]");
      await search.fill("VN000002");
      await page.waitForFunction(() => document.querySelectorAll(".bot-task-row").length === 1);
      await page.locator("[data-detail]").first().click();
      const detail = page.locator(".bot-detail[open]");
      await detail.waitFor();
      assert.ok((await detail.innerText()).includes("pim-publish-2"));
      assert.ok((await detail.innerText()).includes("Product facts and evidence"));
      await page.keyboard.press("Escape");
      await detail.waitFor({ state: "detached" });
      console.log("Verified pagination and details", width);

      let failed = false;
      await page.route("**/api/bots/queue?**", async (route) => {
        if (!failed && new URL(route.request().url()).searchParams.get("q") === "VN000003") {
          failed = true;
          await route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        } else await route.continue();
      });
      await search.fill("VN000003");
      await page.locator("[data-bot-notice]:visible").waitFor();
      assert.equal(await search.inputValue(), "VN000003");
      await page.locator("[data-refresh]").click();
      await page.locator(".bot-task-copy strong").filter({ hasText: "VN000003" }).waitFor();
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale),
        locale === "en" ? "zh-CN" : "en",
      );
      await page
        .locator(".bot-heading h1")
        .filter({ hasText: locale === "en" ? "助理" : "Bots" })
        .waitFor();
      assert.equal(await search.inputValue(), "VN000003");
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      console.log("Verified recovery and locale", width);

      await api("/retention", { days: 5 });
      await page.goto(app.base + "/settings/bots");
      await page.locator("[data-retention]").click();
      const retention = page.locator(".bot-dialog[open]");
      assert.equal(await retention.locator("input[name=retention]").inputValue(), "5");
      await retention.locator("input[name=retention]").fill("7");
      await retention.locator("[type=submit]").click();
      await retention.waitFor({ state: "detached" });
      assert.equal((await api("/retention")).days, 7);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        theme,
        geometry,
        pagination: true,
        recovery: true,
        keyboard: true,
        retention: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    join(out, "compact-result.json"),
    JSON.stringify({ passed: true, records, modelInferenceRequested: false }, null, 2) + "\n",
  );
} finally {
  await app.dispose();
}
