import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture({ applicationChat: true }),
  out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-chat-viewport/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [chromium, 1100, "zh-HK", "silk"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
    try {
      await context.addInitScript(
        ({ locale, theme }) => {
          if (!location.protocol.startsWith("http")) return;
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
          const native = window.visualViewport,
            viewport = new EventTarget();
          for (const name of ["width", "height", "scale", "offsetTop", "offsetLeft"])
            Object.defineProperty(viewport, name, { get: () => viewport["_" + name] ?? native[name] });
          Object.defineProperty(window, "visualViewport", { value: viewport });
          window.__botKeyboardViewport = viewport;
        },
        { locale, theme },
      );
      await app.signIn(context);
      const response = await context.request.post(app.base + "/api/bots", {
        headers: { Origin: app.base },
        data: {
          name: "Reading assistant · A long name that stays on one line · " + locale,
          code: "viewport-" + locale.toLowerCase(),
        },
      });
      assert(response.ok());
      const { bot } = await response.json(),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      let revision = 1,
        replace = false;
      const messages = Array.from({ length: 16 }, (_, index) => ({
        id: "reading-" + index,
        sequence: index + 5,
        generation: 1,
        role: "assistant",
        createdAt: Date.now(),
        status: "complete",
        text: Array.from(
          { length: 8 },
          (_, paragraph) => `Message ${index}, paragraph ${paragraph}. Stable reading content.`,
        ).join("\n\n"),
      }));
      await page.route(`**/api/bots/${bot.id}/chat**`, (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("before"))
          return route.fulfill({
            json: {
              generation: 1,
              messages: Array.from({ length: 4 }, (_, index) => ({
                ...messages[0],
                id: "earlier-" + index,
                sequence: index + 1,
                text: "Earlier context\n\n".repeat(8),
              })),
              hasMore: false,
              busy: false,
              cleanup: "ready",
              cursor: "older",
            },
          });
        return route.fulfill({
          json: {
            generation: 1,
            messages,
            hasMore: true,
            busy: false,
            cleanup: "ready",
            cursor: String(revision),
            replace,
          },
        });
      });
      await page.goto(app.base + `/bots/${bot.id}/chat`);
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      const history = page.locator(".bot-chat-history"),
        composer = page.locator(".bot-chat-composer"),
        input = composer.locator("[data-message]");
      const bottom = () =>
        page.waitForFunction(() => {
          const root = document.querySelector(".bot-chat-history");
          return root.clientHeight > 0 && root.scrollHeight - root.clientHeight - root.scrollTop < 2;
        });
      await bottom();
      await input.fill("Keep this draft during refreshed replies");
      const initial = await composer.boundingBox();
      const heading = page.locator(".bot-chat-heading"),
        headerBox = await heading.boundingBox();
      assert(headerBox.height <= 61, "Conversation chrome uses one compact row");
      assert.equal(await page.locator(".bot-chat-tools").count(), 0);
      for (const control of await heading.locator(".bot-icon-button").all()) {
        const box = await control.boundingBox();
        assert(Math.abs(box.y + box.height / 2 - (headerBox.y + headerBox.height / 2)) < 1);
        assert(box.width >= (width < 768 ? 44 : 40) && box.height >= (width < 768 ? 44 : 40));
      }
      assert.equal(await page.locator("[data-bot-title]").innerText(), bot.name);
      if (width >= 768) {
        const sidebar = await page.locator(".sidebar").boundingBox(),
          shortcut = await page.locator(`[data-bot-shortcut="${bot.id}"]`).boundingBox();
        assert(shortcut.x + shortcut.width <= sidebar.x + sidebar.width, "A long Bot name stays inside navigation");
      }
      assert.equal(await page.locator(".bot-chat-menu-hint").isVisible(), false);
      const options = page.locator("[data-chat-options]"),
        menu = page.locator(".bot-chat-menu");
      await options.click();
      await menu.waitFor();
      await page.screenshot({ path: `${out}/options-${locale}-${width}.png` });
      const menuBox = await menu.boundingBox();
      assert(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1);
      assert.equal(await page.locator(":focus").getAttribute("data-route"), `/bots/${bot.id}/tasks`);
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator(":focus").getAttribute("data-route"), `/bots/${bot.id}/integrations`);
      await page.keyboard.press("Escape");
      assert.equal(await options.getAttribute("aria-expanded"), "false");
      assert.equal(await options.evaluate((node) => node === document.activeElement), true);
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      if (initial.y + initial.height > 961) {
        await page.screenshot({ path: `${out}/layout-failure-${locale}.png` });
        console.log(
          JSON.stringify(
            await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  "#app,.conversation-shell,.workbench-view,#workbenchContent,.bot-home-chat,[data-bot-content],.bot-human-chat,.bot-chat-viewport,.bot-chat-history,.bot-chat-dock",
                ),
              ].map((node) => {
                const css = getComputedStyle(node),
                  box = node.getBoundingClientRect();
                return {
                  node: node.id || node.className,
                  y: box.y,
                  height: box.height,
                  scrollHeight: node.scrollHeight,
                  scrollTop: node.scrollTop,
                  display: css.display,
                  flex: css.flex,
                  minHeight: css.minHeight,
                  overflow: css.overflow,
                  position: css.position,
                };
              }),
            ),
            null,
            2,
          ),
        );
      }
      assert(initial.y >= 0 && initial.y + initial.height <= 961, JSON.stringify(initial));
      const refresh = async (marker) => {
        revision++;
        messages.at(-1).text += "\n\n" + marker;
        await page.locator("[data-refresh]").click();
        await page.getByText(marker, { exact: true }).waitFor({ state: "attached" });
      };
      await refresh("New output while following");
      await bottom();
      const after = await composer.boundingBox();
      assert(
        Math.abs(initial.y - after.y) < 1 && Math.abs(initial.height - after.height) < 1,
        "A refreshed reply cannot move the composer",
      );
      const anchor = page.locator('[data-message-id="reading-8"] p').nth(3);
      await anchor.evaluate((node) => {
        const root = document.querySelector(".bot-chat-history");
        root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
      });
      await page.locator("[data-chat-latest]").waitFor({ state: "visible" });
      const jump = await page.locator("[data-chat-latest]").boundingBox(),
        readingArea = await history.boundingBox();
      assert(
        Math.abs(jump.x + jump.width - (readingArea.x + readingArea.width - 8)) < 2,
        "The latest-message control stays on the reading rail",
      );
      const position = () => anchor.evaluate((node) => node.getBoundingClientRect().top),
        before = await position();
      messages[8].text =
        "Expanded content above the reader. ".repeat(80) +
        "\n\n" +
        messages[8].text.split("\n\n").slice(1).join("\n\n");
      replace = true;
      await refresh("Replaced snapshot during reading");
      await page.waitForTimeout(180);
      assert(Math.abs((await position()) - before) < 2, "Replacing history preserves the visible paragraph");
      await history.evaluate((node) => {
        node.scrollTop = 0;
      });
      const paginationAnchor = page.locator('[data-message-id="reading-0"] p').first(),
        paginationTop = await paginationAnchor.evaluate((node) => node.getBoundingClientRect().top);
      await page.locator("[data-earlier]").click();
      await page.locator('[data-message-id="earlier-0"]').waitFor({ state: "attached" });
      await page.waitForTimeout(180);
      assert(
        Math.abs((await paginationAnchor.evaluate((node) => node.getBoundingClientRect().top)) - paginationTop) < 2,
        "Prepending older messages preserves the reading anchor",
      );
      await page.screenshot({ path: `${out}/reading-${locale}-${width}.png` });
      await page.locator("[data-chat-latest]").click();
      await bottom();
      await page.evaluate(() => {
        const root = document.querySelector(".bot-chat-history"),
          item = root.lastElementChild;
        item.append(
          Object.assign(document.createElement("div"), { style: "height:180px", textContent: "Late decoded media" }),
        );
      });
      await bottom();
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      if (width < 768) {
        await input.focus();
        await page.evaluate(() => {
          const view = window.__botKeyboardViewport;
          view._height = 460;
          view._offsetTop = 18;
          view.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(
          () => Math.abs(document.querySelector("#app").getBoundingClientRect().height - 460) < 1,
        );
        const send = await composer.locator("[type=submit]").boundingBox(),
          area = await history.boundingBox();
        await page.screenshot({ path: `${out}/keyboard-${locale}-${width}.png` });
        if (area.height < 40)
          console.log(
            JSON.stringify(
              await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    ".bot-home-heading,.bot-chat-tools,.bot-chat-dock,.bot-chat-composer,.message-composer-input,.message-composer-footer",
                  ),
                ].map((node) => {
                  const box = node.getBoundingClientRect(),
                    css = getComputedStyle(node);
                  return {
                    node: node.className,
                    y: box.y,
                    height: box.height,
                    min: css.minHeight,
                    max: css.maxHeight,
                    padding: css.padding,
                    font: css.font,
                    flex: css.flex,
                  };
                }),
              ),
              null,
              2,
            ),
          );
        assert(send.y >= 18 && send.y + send.height <= 479, JSON.stringify(send));
        assert(area.height >= 40 && area.y + area.height <= send.y, JSON.stringify(area));
        await composer.locator("[data-composer-control=add]").click();
        const addMenu = page.locator(".composer-add-menu[open]");
        await addMenu.waitFor();
        const sheet = await addMenu.boundingBox();
        assert(sheet.y >= 18 && sheet.y + sheet.height <= 479, JSON.stringify(sheet));
        await page.keyboard.press("Escape");
        assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
        await options.click();
        await menu.waitFor();
        const compactMenu = await menu.boundingBox();
        assert(compactMenu.y >= 18 && compactMenu.y + compactMenu.height <= 479, JSON.stringify(compactMenu));
        await page.keyboard.press("Escape");
        await page.evaluate(() => {
          const view = window.__botKeyboardViewport;
          view._height = 960;
          view._offsetTop = 0;
          view.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(
          () => Math.abs(document.querySelector("#app").getBoundingClientRect().height - 960) < 1,
        );
      }
      await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
      assert.equal(await page.locator("[data-chat-latest]").getAttribute("aria-label"), "Jump to latest messages");
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator(".workbench-view").evaluate((root) => root.scrollTop), 0);
      await page.screenshot({ path: `${out}/latest-${locale}-${width}.png` });
      await options.click();
      await menu.locator(`[data-route="/bots/${bot.id}/tasks"]`).click();
      await page.waitForURL(`**/bots/${bot.id}/tasks`);
      assert.equal(await page.locator(".bot-chat-menu.floating-menu").count(), 0);
      await page.locator(`.bot-home-heading [data-route="/bots/${bot.id}/chat"]`).click();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      await options.click();
      await menu.locator(`[data-route="/bots/${bot.id}/integrations"]`).click();
      await page.waitForURL(`**/bots/${bot.id}/integrations`);
      assert.equal(await page.locator(".bot-chat-menu.floating-menu").count(), 0);
      await page.locator(`.bot-home-heading [data-route="/bots/${bot.id}/chat"]`).click();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      await page.unroute(`**/api/bots/${bot.id}/chat**`);
      await page.locator('.bot-home-heading [data-route="/bots"]').click();
      await page.waitForURL("**/bots");
      assert.equal(await page.locator(".conversation-workspace-view").count(), 0);
      if (width < 768) assert(await page.locator(".workbench-mobile-nav").isVisible());
      await page.goBack();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      assert.equal(await page.locator("[data-message]").inputValue(), "Keep this draft during refreshed replies");
      assert.equal(await page.locator(".bot-chat-composer").count(), 1);
      await options.click();
      await page.locator("[data-clear]").click();
      await page.locator("dialog[open] [data-confirm-clear]").waitFor();
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      assert.equal(await options.evaluate((node) => node === document.activeElement), true);
      assert.equal(await input.inputValue(), "Keep this draft during refreshed replies");
      await options.click();
      await page.locator("[data-clear]").click();
      await page.locator("[data-confirm-clear]").click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      assert.equal(await input.inputValue(), "");
      assert.equal(await page.locator("[data-bot-title]").innerText(), bot.name);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        theme,
        fixedComposer: true,
        followsLatest: true,
        preservesReading: true,
        paginationAnchor: true,
        mediaResize: true,
        keyboardAndMenu: width < 768,
        routeAndDraftRecovery: true,
        compactHeaderHeight: headerBox.height,
        compactHeaderAndKeyboardMenu: true,
        clearConfirmationAndFocusRecovery: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/evidence.json", JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  await app.dispose();
}
