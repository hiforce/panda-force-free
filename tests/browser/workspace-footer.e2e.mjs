import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_FOOTER_SCREENSHOTS || ".artifacts/workspace-footer/screens";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  applicationChat: true,
  applicationChatReply: "A long existing reply with useful detail. ".repeat(500),
  sharedApprovals: true,
  models: [
    {
      id: "gpt-fixture",
      model: "gpt-fixture",
      isDefault: true,
      displayName: "Fixture model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
});
const results = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript((locale) => {
        if (!/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "aurora");
      }, locale);
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [],
        states = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const check = async (state) => {
        await page.locator(".workspace-attribution").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("aria-hidden") !== "true");
        await page.waitForFunction(
          (height) => Math.abs(document.querySelector("#app").getBoundingClientRect().bottom - height) < 2,
          page.viewportSize().height,
        );
        const geometry = await page.evaluate(() => {
          const box = (element) => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
          };
          const footer = document.querySelector(".workspace-attribution");
          return {
            footer: box(footer),
            footerVisible: footer.getClientRects().length > 0,
            reservedHeight: getComputedStyle(document.body).getPropertyValue("--workspace-attribution-height").trim(),
            app: box(document.querySelector("#app")),
            global: footer.parentElement.id === "app",
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: [
              ...document.querySelectorAll(
                ".composer-dock, .bot-chat-composer, .workbench-mobile-nav, #pendingApprovalNotice",
              ),
            ]
              .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
              .map((element) => ({ selector: element.className || element.id, ...box(element) })),
          };
        });
        assert(geometry.global, "Attribution belongs to the application frame, outside reparented chat controls");
        assert.equal(geometry.footerVisible, width >= 768);
        if (width < 768) {
          assert.equal(geometry.reservedHeight, "0px", "H5 does not reserve a footer row");
          assert.equal(geometry.footer.width, 0);
        } else {
          assert(Math.abs(geometry.footer.bottom - geometry.app.bottom) < 2, `${state}: footer is the final row`);
          assert(Math.abs(geometry.footer.bottom - page.viewportSize().height) < 2);
        }
        assert(!geometry.overflow);
        assert(geometry.footer.x >= 0 && geometry.footer.x + geometry.footer.width <= width + 1);
        for (const control of geometry.controls)
          assert(control.bottom <= (geometry.footerVisible ? geometry.footer.y : geometry.app.bottom) + 1);
        states.push({ state, geometry });
        await page.screenshot({ path: `${out}/${state}-${locale}-${width}.png` });
      };
      await page.goto(app.base + "/create");
      await page.locator("#composerSkillControl button").waitFor();
      await check("creation-home");
      await page.locator("#prompt").fill("Write a requirements document with a short acceptance checklist.");
      const submitted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/personal/document-creations") && response.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const task = (await (await submitted).json()).task;
      const question = page.locator(".creation-session-status .user-input-card");
      await question.waitFor();
      await check("creation-running");
      await question.locator(".user-input-option").first().click();
      await question.locator(".user-input-submit").click();
      await waitFor(async () => {
        const response = await context.request.get(app.base + "/api/personal/document-creations/detail?id=" + task.id);
        return (await response.json()).task.state === "succeeded";
      });
      await page.locator("[data-creation-open]:enabled").waitFor();
      await page.locator("#prompt").fill("Keep this continuation draft.");
      await check("creation-saved");
      await page.reload();
      await page.locator("#composerSkillControl button").waitFor();
      await check("creation-reopened");
      for (const accepted of [true, false]) {
        await page.locator("[data-creation-new]").click();
        await page.locator("#prompt").fill("Check cancellation recovery.");
        const submitted = page.waitForResponse(
          (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
        );
        await page.locator("#sendButton").click();
        const id = (await (await submitted).json()).task.id;
        await page.locator(".creation-session-status .user-input-card").waitFor();
        await page.locator("#prompt").fill("Keep the cancellation draft.");
        let commands = 0;
        const cancelPath = "**/api/personal/document-creations/cancel";
        await page.route(cancelPath, async (route) => {
          commands++;
          if (accepted) assert((await route.fetch()).ok());
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Task or save location changed",
              messageId: "creation.conflict",
              messageArgs: {},
              code: "conflict",
            }),
          });
        });
        await page.locator('.creation-session-status [data-creation-action="cancel"]').click();
        if (accepted) {
          await page.locator('.creation-session-status [data-creation-action="retry"]').waitFor();
          assert.equal(await page.locator("[data-task-error]:visible").count(), 0);
        } else {
          await page.locator("[data-task-error]:visible").waitFor();
          const messages = await Bun.file(`src/shared/i18n/locales/${locale}/creation.json`).json();
          assert.equal(await page.locator("[data-task-error]:visible").innerText(), messages.conflict);
        }
        const current = await context.request.get(app.base + "/api/personal/document-creations/detail?id=" + id);
        assert.equal((await current.json()).task.state, accepted ? "cancelled" : "running");
        assert.equal(commands, 1);
        assert.equal(await page.locator("#prompt").inputValue(), "Keep the cancellation draft.");
        await check(accepted ? "cancel-confirmed" : "cancel-conflict");
        await page.unroute(cancelPath);
        if (!accepted)
          assert(
            (
              await context.request.post(app.base + "/api/personal/document-creations/cancel", {
                headers: { Origin: app.base },
                data: { id },
              })
            ).ok(),
          );
      }
      await page.goto(app.base + "/task/old-alpha");
      await page.locator(".session-layout #prompt").waitFor();
      await check("native-chat");
      await page.setViewportSize({ width, height: 540 });
      await page.locator("#prompt").focus();
      await check("short-viewport");
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(app.base + "/bots");
      await page.locator("[data-new-bot]").first().waitFor();
      await check("bot-management");
      const botResponse = await context.request.post(app.base + "/api/bots", {
        headers: { Origin: app.base },
        data: { name: "Footer bot", code: "footer-" + width },
      });
      assert(botResponse.ok());
      const { bot } = await botResponse.json();
      await page.goto(app.base + `/bots/${bot.id}/chat`);
      await page.locator("[data-message]").fill("Show the long reply.");
      await page.locator("[data-message]").press("Enter");
      await page.waitForFunction(() => {
        const reply = document.querySelector('[data-role="assistant"]');
        return reply?.textContent.length > 10000 && !reply.querySelector(".bot-hint");
      });
      await page.locator(".bot-chat-composer").scrollIntoViewIfNeeded();
      await check("long-bot-chat");
      await page.goto(app.base + "/workspace");
      await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      await check("workspace-list");
      assert.deepEqual(errors, []);
      results.push({ locale, width, states, errors });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ passed: true, results }, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      contexts: results.length,
      states: results.reduce((n, r) => n + r.states.length, 0),
    }),
  );
} finally {
  await app.dispose();
}
