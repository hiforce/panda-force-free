import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";
const out = ".artifacts/bot-profile-delete/screens",
  records = [];
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1600, "en"],
  [webkit, 430, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture({ startupTimeoutMs: 60000 }),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
  let store;
  try {
    await app.signIn(context);
    const bots = [];
    for (const [code, name] of [
      ["delete-me", "Private assistant"],
      ["preserve-me", "Other assistant"],
    ]) {
      const r = await context.request.post(app.base + "/api/bots", {
        headers: { Origin: app.base },
        data: { code, name },
      });
      assert.ok(r.ok());
      bots.push((await r.json()).bot);
      await context.request.patch(app.base + "/api/bots/" + bots.at(-1).id, {
        headers: { Origin: app.base },
        data: { active: false },
      });
    }
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.base + "/bots");
    const trigger = page.locator(`[data-delete-assistant="${bots[0].id}"]`);
    await trigger.waitFor();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator(".bot-dialog[open]");
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok((await dialog.boundingBox()).width <= width);
    await page.screenshot({ path: join(out, `confirm-${locale}-${width}.png`) });
    await page.locator("[data-delete-assistant-cancel]").click();
    await trigger.waitFor();
    store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
    const task = store.submit(
      bots[0],
      { externalTaskId: "scope", instructions: "Review", input: { text: "Evidence", images: [] } },
      "instance",
    ).task;
    await trigger.click();
    await page.locator("[data-delete-assistant-confirm]").click();
    await page.waitForFunction(
      () => document.querySelector("dialog[open] [data-bot-dialog-notice]")?.textContent.length > 10,
    );
    assert.equal(store.bots(bots[0].owner).length, 2);
    await page.screenshot({ path: join(out, `blocked-${locale}-${width}.png`) });
    store.bulkDelete(bots[0].owner, { taskIds: [task.id] });
    let lost = false;
    await page.route("**/api/bots/" + bots[0].id, async (route) => {
      if (route.request().method() === "DELETE" && !lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });

    await page.locator("[data-delete-assistant-confirm]").click();
    await page.waitForFunction(() => document.querySelector("[data-delete-assistant-confirm]")?.disabled === false);
    await page.locator("[data-delete-assistant-confirm]").click();
    await dialog.waitFor({ state: "detached" });
    await trigger.waitFor({ state: "detached" });
    assert.equal(store.bots(bots[0].owner).length, 1);
    await page.locator(`[data-edit="${bots[1].id}"]`).waitFor();
    const csrf = await context.request.delete(app.base + "/api/bots/" + bots[1].id, {
      headers: { Origin: "https://foreign.example" },
    });
    assert.ok([401, 403].includes(csrf.status()));
    await page.locator(`[data-edit="${bots[1].id}"]`).click();
    const editor = page.locator(".bot-editor-dialog[open]");
    await editor.waitFor();
    await editor.locator("[data-delete-assistant]").click();
    await page.locator("[data-delete-assistant-cancel]").click();
    assert.equal(await editor.isVisible(), true);
    await editor.locator("[data-delete-assistant]").click();
    await page.locator("[data-delete-assistant-confirm]").click();
    await editor.waitFor({ state: "detached" });
    assert.equal(store.bots(bots[0].owner).length, 0);
    await page.screenshot({ path: join(out, `after-${locale}-${width}.png`) });
    assert.deepEqual(errors, []);
    records.push({ locale, width, cancel: true, busyGuard: true, deleted: true, csrf: true });
  } finally {
    store?.close();
    await context.close();
    await browser.close();
    await app.stop();
  }
}
await writeFile(join(out, "verified.json"), JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
