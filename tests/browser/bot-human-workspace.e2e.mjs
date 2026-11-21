import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture({ applicationChat: true, sharedApprovals: true }),
  out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-human-workspace/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1100, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + "/api/bots" + path, {
          data,
          headers: { Origin: app.base },
        });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const { bot } = await api("", {
        name: "盼盼 <Curious & Kind> " + width,
        code: "human-" + width,
        persona: {
          role: "History companion",
          traits: "Curious, patient and thoughtful",
          voice: "Friendly and concise",
          motto: "Every question opens a door.",
        },
      });
      const page = await context.newPage(),
        errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") console.log("Browser console:", m.text());
      });
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/bots");
      await page
        .locator(`[data-edit="${bot.id}"]`)
        .waitFor()
        .catch(async (error) => {
          console.log("Workspace failure:", await page.locator("body").innerText(), errors);
          await page.screenshot({ path: join(out, "failure.png") });
          throw error;
        });
      assert.equal(await page.locator("[data-bot-task-rows]").count(), 0);
      assert.ok(await page.locator("[data-summary=bots]").innerText());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const row = await page.locator(".bot-manager-row").first().boundingBox();
      assert.ok(row.height <= (width < 768 ? 185 : 105), "Bot management must remain compact");
      await page.screenshot({ path: join(out, `home-${locale}-${width}.png`) });
      if (width < 768) await page.locator("#workspaceNavigationToggle").click();
      const shortcut = page.locator(`[data-bot-shortcut="${bot.id}"]`);
      await shortcut.waitFor();
      await page.screenshot({ path: join(out, `sidebar-${locale}-${width}.png`) });
      await shortcut.click();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      await page.locator("[data-message]").waitFor();
      if (width === 320) {
        bot.name = "盼盼 <Curious & Kind> " + "LongName".repeat(11);
        await api("/" + bot.id, { name: bot.name }, "patch");
        await page.reload();
        await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
        await page.locator("[data-message]").waitFor();
      }
      const input = page.locator("[data-message]");
      await input.fill("Keep this draft while I look at my tasks.");
      await page.locator("[data-chat-options]").click();
      await page.locator(`.bot-chat-menu [data-route="/bots/${bot.id}/tasks"]`).click();
      await page.locator("[data-bot-task-rows]").waitFor();
      assert.equal(await page.locator("[data-bot-select]").inputValue(), bot.id);
      assert.equal(await page.locator("[data-bot-select]").isDisabled(), true);
      await page.goBack();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      await page.locator("[data-message]").waitFor();
      assert.equal(await input.inputValue(), "Keep this draft while I look at my tasks.");
      let lost = false;
      await page.route(`**/api/bots/${bot.id}/chat`, async (route) => {
        if (route.request().method() === "POST" && !lost) {
          lost = true;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
      await page.locator(".bot-chat-composer [type=submit]").click();
      await page
        .locator(".bot-chat-text strong")
        .filter({ hasText: "What shall we explore?" })
        .waitFor()
        .catch(async (error) => {
          console.log("Chat failure:", await page.locator("body").innerText(), errors);
          await page.screenshot({ path: join(out, "chat-failure.png") });
          throw error;
        });
      console.log("Chat reply visible", locale);
      const assistantName = page.locator('.bot-chat-message[data-role="assistant"] > header > strong');
      assert.equal(await assistantName.innerText(), bot.name);
      assert.equal(await assistantName.locator("[data-i18n-ignore]").count(), 1);
      assert.equal(await assistantName.locator("curious").count(), 0);
      await page.waitForFunction(() => document.querySelector("[data-message]").value === "");
      assert.equal(
        (await api("/" + bot.id + "/chat")).messages.length,
        2,
        "A lost HTTP reply must not cause another model run",
      );
      await input.fill("A draft that must disappear when chat is cleared.");
      console.log("Draft and lost response checked", locale);
      const second = await context.newPage();
      second.on("pageerror", (error) => errors.push(error.message));
      await second.goto(app.base + `/bots/${bot.id}/chat`);
      await second
        .locator("[data-clear]:enabled")
        .waitFor({ state: "attached" })
        .catch(async (error) => {
          console.log("Second tab failure:", await second.locator("body").innerText(), errors);
          await second.screenshot({ path: join(out, "second-tab-failure.png") });
          throw error;
        });
      await second.locator("[data-message]").waitFor();
      console.log("Second tab ready", locale);
      assert.equal(
        await second.locator('.bot-chat-message[data-role="assistant"] > header > strong').innerText(),
        bot.name,
      );
      await second.locator("[data-chat-options]").click();
      await second.locator("[data-clear]").click();
      await second.locator("[data-confirm-clear]").click();
      await second.locator("[data-chat-empty]").waitFor();
      console.log("Cleared in second tab", locale);
      await page.locator("[data-chat-empty]").waitFor();
      assert.equal(await input.inputValue(), "");
      assert.equal((await api("/" + bot.id + "/chat")).messages.length, 0);
      await second.close();
      await input.fill("Tell me something new.");
      await page.locator(".bot-chat-composer [type=submit]").click();
      await page
        .locator(".bot-chat-text strong")
        .filter({ hasText: "What shall we explore?" })
        .waitFor()
        .catch(async (error) => {
          console.log("Chat failure:", await page.locator("body").innerText(), errors);
          await page.screenshot({ path: join(out, "chat-failure.png") });
          throw error;
        });
      console.log("Chat reply visible", locale);
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale),
        locale === "en" ? "zh-CN" : "en",
      );
      await page.waitForFunction(
        (locale) => document.documentElement.lang === locale,
        locale === "en" ? "zh-CN" : "en",
      );
      assert.equal(await page.locator(".bot-chat-text strong").innerText(), "What shall we explore?");
      assert.equal(await assistantName.innerText(), bot.name);
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await input.fill("My next question…");
      await input.focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-composer-control="add"]')), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.matches("button[type=submit]")), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `chat-${locale}-${width}.png`) });
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        compactManagement: true,
        directSidebarChat: true,
        scopedTasks: true,
        draftNavigation: true,
        lostResponseRecovered: true,
        crossTabClear: true,
        languageSwitch: true,
        keyboard: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "evidence.json"), JSON.stringify(records, null, 2) + "\n");
  console.log(JSON.stringify(records));
} finally {
  await app.dispose();
}
