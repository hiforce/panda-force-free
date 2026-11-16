import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const out = ".artifacts/bot-lifecycle/screens";
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 320, "zh-CN"],
]) {
  const app = await createAppFixture(),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
  try {
    await app.signIn(context);
    const response = await context.request.post(app.base + "/api/bots", {
      data: {
        name: "Product quality reviewer",
        code: "lifecycle-test",
        instructions: "Check supplied facts",
        callbackHosts: ["api.example.com"],
      },
    });
    assert.ok(response.ok());
    const { bot } = await response.json();
    await context.request.patch(app.base + "/api/bots/" + bot.id, { data: { active: false } });
    const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite")),
      tasks = [];
    try {
      for (const [status, decision, failure] of [
        ["discarded", "discard"],
        ["kept", "keep"],
        ["review", "review"],
        ["review", null, "execution"],
        ["queued", null],
        ["suspended", null],
        ["canceled", null],
        ["running", null],
      ]) {
        const { task } = store.submit(
          bot,
          {
            externalTaskId: "product-" + tasks.length,
            instructions: "Check",
            input: { text: "TEAM VISOR " + tasks.length, images: [] },
          },
          "lifecycle-" + tasks.length,
        );
        Object.assign(task, {
          status,
          decision,
          failure,
          reason: decision === "discard" ? "External product task discarded successfully." : "Check supplied facts.",
        });
        delete task.state;
        delete task.callbackStatus;
        store.db
          .query("UPDATE bot_tasks SET status=?,data=?,leaseUntil=? WHERE id=?")
          .run(status, JSON.stringify(task), Date.now() + 600000, task.id);
        tasks.push(task);
      }
    } finally {
      store.close();
    }
    const queueResponse = await context.request.get(app.base + "/api/bots/queue"),
      queue = await queueResponse.json();
    assert.deepEqual(
      tasks.map((t) => queue.tasks.find((item) => item.id === t.id).state),
      ["finished", "finished", "suspended", "error", "created", "suspended", "canceled", "running"],
    );
    const blocked = await context.request.post(app.base + "/api/bots/tasks/" + tasks[4].id + "/cancel", {
      data: {},
      headers: { origin: "https://untrusted.example" },
    });
    assert.ok([401, 403].includes(blocked.status()));
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.base + "/bots");
    const row = (index) => page.locator(`[data-task-id="${tasks[index].id}"]`);
    await row(0).waitFor();
    assert.match(await row(0).locator(".bot-status").innerText(), locale === "en" ? /Finished/ : /已完成/);
    assert.match(await row(0).locator(".bot-outcome").innerText(), locale === "en" ? /Discard/ : /废弃/);
    assert.match(await row(3).locator(".bot-outcome").innerText(), locale === "en" ? /Not decided/ : /未判定/);
    assert.equal(await page.locator("[data-filter] option").count(), 10);
    await page.screenshot({ path: `${out}/states-${width}.png` });
    await row(0).locator("[data-detail]").click();
    const detail = page.locator("dialog.bot-detail[open]");
    await detail.waitFor();
    assert.equal(await detail.locator("[data-action=cancel]").count(), 0);
    assert.match(await detail.locator(".bot-callback-state").innerText(), locale === "en" ? /Delivered/ : /成功送达/);
    await page.screenshot({ path: `${out}/finished-${width}.png` });
    await page.keyboard.press("Escape");
    await row(4).locator("[data-detail]").click();
    await detail.locator("[data-action=suspend]").click();
    await detail.waitFor({ state: "detached" });
    assert.equal(await row(4).locator(".bot-status").getAttribute("data-status"), "suspended");
    await row(4).locator("[data-detail]").click();
    await detail.locator("[data-action=resume]").click();
    await detail.waitFor({ state: "detached" });
    assert.equal(await row(4).locator(".bot-status").getAttribute("data-status"), "created");
    await row(4).locator("[data-detail]").click();
    page.once("dialog", (dialog) => dialog.accept());
    await detail.locator("[data-action=cancel]").click();
    await detail.waitFor({ state: "detached" });
    assert.equal(await row(4).locator(".bot-status").getAttribute("data-status"), "canceled");
    await page.locator("[data-filter]").selectOption("finished");
    assert.equal(await page.locator(".bot-task-row").count(), 2);
    await page.locator("[data-filter]").selectOption("canceled");
    assert.equal(await page.locator(".bot-task-row").count(), 2);
    const final = await context.request.get(app.base + "/api/bots/tasks/" + tasks[4].id),
      result = await final.json();
    assert.equal(result.task.state, "canceled");
    assert.equal(result.task.decision, null);
    assert.equal(result.events.filter((e) => e.kind.startsWith("callback_")).length, 0);
    await page.reload();
    await row(4).waitFor();
    assert.equal(await row(4).locator(".bot-status").getAttribute("data-status"), "canceled");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await app.stop();
  }
}
