import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_SIDEBAR_TABS_PROOF || ".artifacts/sidebar-mobile-tabs";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ historySessions: 40, startupTimeoutMs: 60000 }),
  records = [];
try {
  for (const [width, height] of [
    [390, 844],
    [320, 568],
  ])
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const browser = await webkit.launch(),
        context = await browser.newContext({
          ...devices["iPhone 13"],
          viewport: { width, height },
          colorScheme: "dark",
        });
      try {
        await app.signIn(context);
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(app.base + "/new");
        await page.locator("#prompt:visible").fill("Retained sidebar draft.");
        await page.locator("#workspaceNavigationToggle").click();
        await page.locator("#sidebar.mobile-open").waitFor();
        assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
        assert(await page.locator("#sidebarMenuPanel").isVisible());
        assert.equal(await page.locator("#sidebarSessionsPanel").isVisible(), false);
        const routes = await page
          .locator(".workbench-navigation > [data-route]")
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.route));
        assert.deepEqual(routes, ["workspace", "bots", "tasks", "create", "projects", "skills", "publish"]);
        const lastMenu = page.locator('.workbench-navigation > [data-route="publish"]');
        await lastMenu.scrollIntoViewIfNeeded();
        assert((await lastMenu.boundingBox()).height >= 44);
        await page.locator("#sidebarSessionsTab").tap();
        await page.locator('.sidebar-project-group[data-project="__tasks__"] .thread-item').first().waitFor();
        assert.equal(await page.locator("#sidebarMenuPanel").isVisible(), false);
        const panel = page.locator("#sidebarSessionsPanel"),
          search = page.locator("#sessionWorkspaceSearch");
        assert((await panel.boundingBox()).height > 220);
        assert((await search.boundingBox()).height >= 44);
        const row = page.locator('.sidebar-project-group[data-project="__tasks__"] .thread-item').first();
        assert((await row.boundingBox()).height >= 44);
        await panel.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const scroll = await panel.evaluate((node) => node.scrollTop);
        assert(scroll > 0);
        const searchBox = await search.boundingBox(),
          panelBox = await panel.boundingBox();
        assert(searchBox.y >= panelBox.y - 1 && searchBox.y + searchBox.height <= panelBox.y + panelBox.height + 1);
        await page.locator("#sidebarMenuTab").tap();
        await page.locator("#sidebarSessionsTab").tap();
        assert(Math.abs((await panel.evaluate((node) => node.scrollTop)) - scroll) < 2);
        await page.screenshot({ path: `${out}/sessions-${locale}-${width}.png`, scale: "css" });
        await page.locator("#sidebarSessionsTab").press("Home");
        assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
        await page.screenshot({ path: `${out}/menu-${locale}-${width}.png`, scale: "css" });
        await page.locator("#sidebarMenuTab").press("End");
        if (width === 390 && locale === "en") {
          const settings = await context.newPage();
          await settings.goto(app.base + "/settings/general-settings");
          await settings.locator('[data-settings-page="general-settings"]').click();
          await settings.locator("#languageSelect").selectOption("zh-TW");
          await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
          assert.equal(await page.locator("#sidebarMenuTab").textContent(), "選單");
          assert.equal(await page.locator("#sidebarSessionsTab").getAttribute("aria-selected"), "true");
          assert.equal(await page.locator("#prompt").inputValue(), "Retained sidebar draft.");
          await settings.close();
        }
        await search.tap();
        await page.locator("#wbCommandQuery").waitFor();
        await page.locator("#wbCommandQuery").fill("Old alpha");
        await page.locator("#wbCommandResults button").filter({ hasText: "Old alpha" }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator("#workspaceNavigationToggle").click();
        assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
        await page.locator("#sidebarMenuTab").press("Escape");
        assert.equal(await page.locator("#sidebar").evaluate((node) => node.classList.contains("mobile-open")), false);
        assert.equal(await page.evaluate(() => document.activeElement.id), "workspaceNavigationToggle");
        assert.equal(await page.locator("#prompt").inputValue(), "Retained sidebar draft.");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.locator("#workspaceNavigationToggle").click();
        await page.locator("#sidebarSessionsTab").tap();
        await row.scrollIntoViewIfNeeded();
        await row.tap();
        await page.waitForURL(/\/task\//);
        await page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("mobile-open"));
        assert.deepEqual(errors, []);
        records.push({
          engine: "webkit",
          width,
          height,
          locale,
          defaultMenu: true,
          menuInventory: routes,
          touchTargets: true,
          sessionSpace: true,
          stickySearch: true,
          scrollPreserved: true,
          keyboard: true,
          draftPreserved: true,
          openSession: true,
          errors,
        });
      } finally {
        await context.close();
        await browser.close();
      }
    }
  for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
    const browser = await chromium.launch(),
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage();
      await page.goto(app.base + "/new");
      await page.locator("#prompt:visible").fill("Retained desktop draft.");
      assert(await page.locator("#sidebarSectionTabs").isVisible());
      assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#sidebarSessionsPanel").isVisible(), false);
      await page.screenshot({ path: `${out}/desktop-menu-${locale}-1440.png` });
      await page.locator("#sidebarMenuTab").press("ArrowRight");
      const panel = page.locator("#sidebarSessionsPanel"),
        search = page.locator("#sessionWorkspaceSearch");
      await page.locator("#threadList .thread-item").first().waitFor();
      assert.equal(await page.locator("#sidebarMenuPanel").isVisible(), false);
      assert((await panel.boundingBox()).height > 500);
      assert(await search.isVisible());
      await panel.evaluate((n) => {
        n.scrollTop = n.scrollHeight;
      });
      const scroll = await panel.evaluate((n) => n.scrollTop);
      await page.locator("#sidebarSessionsTab").press("ArrowLeft");
      await page.locator("#sidebarMenuTab").press("End");
      assert(Math.abs((await panel.evaluate((n) => n.scrollTop)) - scroll) < 2);
      await page.screenshot({ path: `${out}/desktop-sessions-${locale}-1440.png` });
      const resize = page.locator(".workspace-sidebar-resizer:visible").first();
      await resize.focus();
      await resize.press("ArrowRight");
      const sidebarWidth = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--workspace-sidebar-width")),
      );
      await page.waitForFunction(
        (width) => Math.abs(document.querySelector("#sidebar").getBoundingClientRect().width - width) < 0.1,
        sidebarWidth,
      );
      await search.click();
      await page.locator("#wbCommandQuery").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#prompt").inputValue(), "Retained desktop draft.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#workspaceNavigationToggle").click();
      assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
      await page.locator("#sidebarSessionsTab").click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(
        (width) => Math.abs(document.querySelector("#sidebar").getBoundingClientRect().width - width) < 0.1,
        sidebarWidth,
      );
      assert(await page.locator("#sidebarSectionTabs").isVisible());
      assert.equal(await page.locator("#sidebarSessionsTab").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#sidebarMenuPanel").isVisible(), false);
      await page.locator("#sidebarSessionsTab").press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement.id), "workspaceNavigationToggle");
      await page.locator("#workspaceNavigationToggle").click();
      assert.equal(await page.locator("#sidebarMenuTab").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#prompt").inputValue(), "Retained desktop draft.");
      records.push({
        engine: "chromium",
        width: 1440,
        locale,
        desktopTabs: true,
        keyboard: true,
        sidebarWidth,
        resizeRecovery: true,
        searchAndDraft: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log("PC/H5 sidebar sections, keyboard, width, scroll/search/navigation and draft recovery passed.");
} finally {
  await app.dispose();
}
