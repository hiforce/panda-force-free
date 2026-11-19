import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const app = await createAppFixture(),
  out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-integrations/screens",
  evidence = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1100, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale }),
      errors = [];
    try {
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      await app.signIn(context);
      const api = async (path, data) => {
        const r = await context.request[data ? "post" : "get"](app.base + "/api/bots" + path, {
          data,
          headers: { Origin: app.base },
        });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const { bot } = await api("", {
          code: "integration-" + width,
          name: "Research Panda",
          persona: {
            role: "Research companion",
            traits: "Careful and curious",
            voice: "Clear",
            motto: "Keep learning.",
          },
        }),
        page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + `/bots/${bot.id}/integrations`);
      await page.locator("[data-add-integration]").waitFor();
      await page.locator("[data-add-integration]").click();
      const form = page.locator("[data-integration-editor]");
      await form.locator('[name="pf-bot-name"]').fill("Morning research digest");
      await form.locator('[name="url"]').fill("https://example.com/history.xml");
      await form
        .locator('[name="instructions"]')
        .fill("Summarize new evidence, include the sources, and note uncertainty.");
      await form.locator('[name="enabled"]').uncheck();
      assert.equal(await form.locator('[name="retention"]').inputValue(), "30");
      assert.equal(
        await page.evaluate(
          () => document.querySelector("dialog").scrollWidth > document.querySelector("dialog").clientWidth + 1,
        ),
        false,
      );
      await page.screenshot({ path: join(out, `editor-${locale}-${width}.png`) });
      await form.locator('[type="submit"]').click();
      await page.locator(".bot-dialog").waitFor({ state: "detached" });
      await page.locator("[data-select-integration]").filter({ hasText: "Morning research digest" }).waitFor();
      const { integrations } = await api(`/${bot.id}/integrations`),
        entry = integrations.find((v) => v.config.name === "Morning research digest");
      assert.equal(entry.config.enabled, false);
      await page.locator("[data-connections]").click();
      await page.locator("[data-add-connection]").click();
      const connection = page.locator("[data-connection-editor]");
      await connection.locator('[name="pf-bot-name"]').fill("Team Slack");
      await connection.locator('[name="pf-bot-token"]').fill("fixture-secret-not-a-real-token");
      await connection.locator('[type="submit"]').click();
      await page.locator(".bot-dialog").waitFor({ state: "detached" });
      await page.locator("[data-edit-connection]").first().waitFor();
      await page.locator("[data-edit-connection]").first().click();
      assert.equal(await page.locator('[name="pf-bot-token"]').inputValue(), "");
      await page.keyboard.press("Escape");
      // Seed a retained result in the isolated fixture only; model/source execution is covered by the runtime integration suite.
      const state = new BotStore(join(app.dir, "panda-state", "data", "bot-tasks.sqlite")),
        now = Date.now(),
        messageId = String(now).padStart(16, "0") + ":" + randomUUID(),
        runId = entry.config.id + ":" + String(now).padStart(16, "0") + ":" + randomUUID();
      await state.workspace.batch(bot.owner, {
        checks: [{ kind: "channel-message", id: messageId, version: null }],
        puts: [
          {
            kind: "channel-message",
            id: messageId,
            botId: bot.id,
            state: "active",
            dueAt: null,
            expiresAt: now + 30 * 86400000,
            data: {
              id: messageId,
              integrationId: entry.config.id,
              runId,
              text: "A careful research digest. Source facts remain distinct from assumptions.\n\nThis is seeded fixture content.",
              title: "Morning research digest",
              kind: "digest",
              generation: 1,
              createdAt: now,
              expiresAt: now + 30 * 86400000,
              sources: [{ title: "Read the source", url: "https://example.com/evidence" }],
            },
          },
        ],
      });
      state.close();
      await page.locator("[data-connections]").click();
      await page.locator("[data-refresh]").click();
      await page.locator(".bot-channel-text").filter({ hasText: "careful research digest" }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `channel-${locale}-${width}.png`) });
      await page.locator("[data-edit-integration]").click();
      await page.locator('[name="pf-bot-name"]').fill("Unsaved retry input");
      let failed = false;
      await page.route(`**/api/bots/${bot.id}/integrations`, async (route) => {
        if (route.request().method() === "POST" && !failed) {
          failed = true;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "integrationUnavailable" } }),
          });
        } else await route.continue();
      });
      await page.locator(".bot-dialog [type=submit]").click();
      await page.locator(".bot-dialog [data-bot-dialog-notice]").filter({ hasText: /./ }).waitFor();
      assert.equal(await page.locator('[name="pf-bot-name"]').inputValue(), "Unsaved retry input");
      assert.equal(await page.locator(".bot-dialog [type=submit]").isEnabled(), true);
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
      evidence.push({
        locale,
        width,
        configAndConnections: true,
        secretsHidden: true,
        privateChannel: true,
        retryKeepsInput: true,
        keyboard: true,
        overflow: false,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.dispose();
}
