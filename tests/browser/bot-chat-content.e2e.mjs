import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const markdown =
    '# 新人入职清单\n\n## 入职前准备\n\n1. 开通 **工作账号**\n2. 安排入职导师\n\n| 时间 | 负责人 |\n| --- | --- |\n| 第一天 | HR |\n\n> 重要：请先确认设备已准备好。\n\n```json\n{"welcome": true}\n```\n\n<script>window.__botXss = true</script>',
  reply =
    "当然可以，这是可以直接使用的内容。\n\n````markdown\n" +
    markdown +
    "\n````\n\n你可以根据团队情况调整。\n\n```python\nprint('ready')\n```",
  app = await createAppFixture({ applicationChat: true, sharedApprovals: true, applicationChatReply: reply }),
  out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-chat-content/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "light"],
    [webkit, 390, "zh-CN", "aurora"],
    [chromium, 1100, "zh-HK", "light"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 1100 }, locale });
    try {
      await context.addInitScript(
        ({ locale, theme }) => {
          if (!/^https?:$/.test(location.protocol)) return;
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
          globalThis.__botCopied = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text) => {
                globalThis.__botCopied.push(text);
              },
              write: async (items) => {
                globalThis.__botCopied.push(await (await items[0].getType("text/plain")).text());
              },
            },
          });
        },
        { locale, theme },
      );
      await app.signIn(context);
      const api = async (path, data) => {
        const response = await context.request[data ? "post" : "get"](app.base + "/api/bots" + path, {
          data,
          headers: { Origin: app.base },
        });
        assert(response.ok(), await response.text());
        return response.json();
      };
      const { bot } = await api("", { name: "盼盼 · 入职助手", code: "content-" + width });
      const page = await context.newPage(),
        errors = [];
      let sends = 0;
      page.setDefaultTimeout(25000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === `/api/bots/${bot.id}/chat`) sends++;
      });
      await page.goto(app.base + `/bots/${bot.id}/chat`);
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      const input = page.locator("[data-message]"),
        placeholder = await input.getAttribute("placeholder");
      await input.waitFor({ state: "visible" });
      assert(placeholder.includes("Enter") && placeholder.includes("Shift + Enter"));
      const attribution = page.locator(".workspace-attribution");
      assert.equal(await attribution.isVisible(), width >= 768);
      const footer = await attribution.boundingBox();
      if (width >= 768) {
        assert((await attribution.innerText()).includes("HiFORCE Open Source Team"));
        assert((await attribution.locator("a").getAttribute("href")).endsWith("/LICENSE"));
        assert(footer.x >= 0 && footer.x + footer.width <= width + 1);
        assert(Math.abs(footer.y + footer.height - page.viewportSize().height) < 2);
      } else {
        assert.equal(footer, null);
        assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), false);
        const dock = await page.locator(".bot-chat-dock").boundingBox();
        assert(Math.abs(dock.y + dock.height - page.viewportSize().height) < 2);
      }

      const tools = await page.locator(".bot-chat-heading .bot-icon-button").evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: button.getAttribute("aria-label"),
          title: button.getAttribute("title"),
          icons: button.querySelectorAll("svg").length,
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        })),
      );
      assert.equal(tools.length, 3);
      for (const tool of tools) {
        assert(tool.label && tool.title === tool.label);
        assert.equal(tool.icons, 1);
        assert(Math.abs(tool.width - tool.height) < 1);
        assert(tool.width >= (width < 768 ? 44 : 40));
      }
      assert.equal(await page.locator("[data-bot-title]").innerText(), bot.name);
      await input.press("Enter");
      assert.equal(sends, 0);
      await input.fill("帮我准备入职清单");
      await input.press("Shift+Enter");
      assert.equal(await input.inputValue(), "帮我准备入职清单\n");
      await input.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }])
          element.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }),
          );
      });
      assert.equal(sends, 0, "IME confirmation and a held Enter must not send");
      await input.press("Enter");
      const assistant = page.locator('.bot-chat-message[data-role="assistant"]');
      await assistant.locator("[data-content-block]").first().waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-role="assistant"] .bot-hint'));
      assert.equal(sends, 1);
      assert.equal(await assistant.locator(":scope > header > strong").innerText(), bot.name);
      assert.equal(await assistant.locator(".bot-chat-content-card").count(), 2);
      assert.equal(await assistant.locator("table").count(), 1);
      assert.equal(await assistant.locator("blockquote").count(), 1);
      assert.equal(await assistant.locator("script, img[onerror]").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.__botXss), undefined);
      const card = assistant.locator(".bot-chat-content-card").first();
      assert.equal(await card.locator("textarea").isVisible(), false);
      await card.locator('[data-content-view="source"]').click();
      assert.equal(await card.locator("[data-content-preview]").isVisible(), false);
      assert.equal(await card.locator("textarea").isVisible(), true);
      assert.equal(await card.locator("textarea").inputValue(), markdown);
      assert.equal(await card.locator("textarea").getAttribute("readonly"), "");
      await card.locator("[data-copy-content]").click();
      await page.waitForFunction((text) => globalThis.__botCopied.at(-1) === text, markdown);
      await card.locator('[data-content-view="preview"]').click();
      assert.equal(await card.locator("textarea").isVisible(), false);
      assert.equal(await card.locator("[data-content-preview]").isVisible(), true);
      await assistant.locator("[data-copy-message]").click();
      await page.waitForFunction((text) => globalThis.__botCopied.at(-1) === text, reply);
      await input.fill("保留下一条消息草稿");
      await page.locator("[data-chat-options]").click();
      await page.locator("[data-copy-conversation]").click();
      await page.waitForFunction(
        (text) => globalThis.__botCopied.at(-1)?.includes(text) && globalThis.__botCopied.at(-1)?.startsWith("## "),
        reply,
      );
      assert.equal(await input.inputValue(), "保留下一条消息草稿");
      await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
      assert.equal(
        await input.getAttribute("placeholder"),
        "Write a message… Enter to send, Shift + Enter for a new line",
      );
      assert.equal(await assistant.locator(":scope > header > strong").innerText(), bot.name);
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert.equal(await input.getAttribute("placeholder"), placeholder);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const rails = [];
      const originalSize = page.viewportSize();
      for (const [viewportWidth, modes] of width === 1440
        ? [[3200, ["comfortable", "wide", "fill"]]]
        : [[width, ["comfortable", "fill"]]]) {
        await page.setViewportSize({ width: viewportWidth, height: 1100 });
        for (const mode of modes) {
          const rail = await page.evaluate((mode) => {
            document.documentElement.dataset.workbenchWidth = mode;
            const box = (selector) => {
                const { x, width } = document.querySelector(selector).getBoundingClientRect();
                return { x, width };
              },
              shell = box(".conversation-shell"),
              viewStyle = getComputedStyle(document.querySelector(".workbench-view")),
              gutter = parseFloat(viewStyle.paddingInlineStart),
              available = shell.width - gutter * 2,
              expectedWidth = mode === "comfortable" ? Math.min(800, available) : available;
            return {
              mode,
              viewportWidth: innerWidth,
              expected: { x: shell.x + (shell.width - expectedWidth) / 2, width: expectedWidth },
              heading: box(".bot-home-heading"),
              chat: box(".bot-human-chat"),
              reply: box('.bot-chat-message[data-role="assistant"]'),
              card: box(".bot-chat-content-card"),
              composer: box(".bot-chat-composer"),
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          }, mode);
          for (const key of ["heading", "chat", "reply", "card", "composer"]) {
            assert(Math.abs(rail[key].x - rail.expected.x) < 2, `${key} left edge: ${JSON.stringify(rail)}`);
            assert(Math.abs(rail[key].width - rail.expected.width) < 2, `${key} width: ${JSON.stringify(rail)}`);
          }
          assert.equal(rail.overflow, false);
          rails.push(rail);
          await page.screenshot({ path: `${out}/rail-${locale}-${viewportWidth}-${mode}.png` });
        }
      }
      await page.setViewportSize(originalSize);
      await page.evaluate(() => (document.documentElement.dataset.workbenchWidth = "comfortable"));
      await page.locator(".bot-chat-history").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: `${out}/content-${locale}-${width}.png` });
      await card.locator('[data-content-view="source"]').click();
      await page.screenshot({ path: `${out}/source-${locale}-${width}.png` });
      if (width === 1440) {
        const route = `**/api/bots/${bot.id}/chat**`,
          history = Array.from({ length: 103 }, (_, index) => ({
            id: "history-" + index,
            sequence: index + 1,
            generation: 1,
            role: index % 2 ? "assistant" : "user",
            text: "record-" + String(index + 1).padStart(4, "0"),
            createdAt: Date.now(),
            status: "complete",
          }));
        let wrongGeneration = false,
          copiedPages = 0;
        await page.route(route, (request) => {
          const url = new URL(request.request().url()),
            before = url.searchParams.get("before");
          if (url.searchParams.has("since"))
            return request.fulfill({ json: { unchanged: true, cursor: "1:103:1:0:ready" } });
          if (before) copiedPages++;
          return request.fulfill({
            json: {
              generation: before && wrongGeneration ? 2 : 1,
              messages: before ? history.slice(0, 3) : history.slice(3),
              hasMore: !before,
              busy: false,
              cleanup: "ready",
              cursor: "1:103:1:0:ready",
            },
          });
        });
        await page.reload();
        await page.locator("[data-earlier]:enabled").waitFor();
        assert.equal(await page.locator(".bot-chat-message").count(), 100);
        await page.locator("[data-chat-options]").click();
        await page.locator("[data-copy-conversation]").click();
        await page.waitForFunction(() => globalThis.__botCopied.at(-1)?.includes("record-0001"));
        assert.equal(copiedPages, 1);
        const transcript = await page.evaluate(() => globalThis.__botCopied.at(-1));
        assert(transcript.includes("record-0103"));
        assert(transcript.indexOf("record-0001") < transcript.indexOf("record-0103"));
        const count = await page.evaluate(() => globalThis.__botCopied.length);
        wrongGeneration = true;
        await page.locator("[data-chat-options]").click();
        await page.locator("[data-copy-conversation]:not([aria-busy])").click();
        await page.waitForFunction(() =>
          document.querySelector("[data-bot-notice]")?.textContent.includes("This conversation was cleared"),
        );
        assert.equal(
          await page.evaluate(() => globalThis.__botCopied.length),
          count,
          "A cleared generation must not publish a partial transcript",
        );
        await page.unroute(route);
      }
      assert.deepEqual(errors, []);
      const ordinary = await context.newPage();
      try {
        await ordinary.goto(app.base + "/task/old-alpha");
        await ordinary.locator(".session-layout #prompt").waitFor();
        const footer = await ordinary.locator(".workspace-attribution").boundingBox(),
          composer = await ordinary.locator(".composer-dock").boundingBox();
        const boundary = footer?.y ?? ordinary.viewportSize().height;
        assert(composer.y + composer.height <= boundary + 1);
        if (footer) assert(footer.x >= 0 && footer.x + footer.width <= width + 1);
        const notice = ordinary.locator("#pendingApprovalNotice");
        if (await notice.isVisible()) {
          const box = await notice.boundingBox();
          assert(box.y + box.height <= boundary + 1);
        }
        await ordinary.screenshot({ path: `${out}/ordinary-footer-${locale}-${width}.png` });
      } finally {
        await ordinary.close();
      }
      records.push({
        locale,
        width,
        theme,
        rails,
        configuredBotName: true,
        enterSend: true,
        shiftEnterNewline: true,
        imeSafe: true,
        copyRawReplyAndContent: true,
        copyConversation: true,
        localeRecovery: true,
        openSourceAttribution: true,
        markdownSafety: true,
        overflow: false,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(`${out}/evidence.json`, JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  await app.dispose();
}
