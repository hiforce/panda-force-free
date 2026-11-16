import { createConversationHistory } from "../../src/server/conversation/history.js";
import { webkit } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";

const fixture = await createBrowserFixture();
const browser =
  process.env.PANDA_FORCE_TEST_BROWSER === "webkit"
    ? await webkit.launch({ headless: true })
    : await fixture.launchBrowser(launchOptions());
const directory = ".artifacts/workspace-layout";
await mkdir(directory, { recursive: true });
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "light",
    locale: "en",
  });
  await fixture.signIn(context);
  await context.request.post(fixture.base + "/api/system/database/selection", {
    data: { driver: "sqlite" },
    headers: { Origin: fixture.base },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture.rpc("thread/name/set", { threadId: "old-alpha", name: "Workspace review" });
  const history = createConversationHistory({
    readThread: async () => ({
      id: "old-alpha",
      name: "Workspace review",
      cwd: fixture.alpha,
      status: { type: "idle" },
      turns: [
        {
          id: "chrome-turn",
          status: "completed",
          items: [
            {
              id: "chrome-user",
              type: "userMessage",
              content: [{ type: "text", text: "Review the workspace and prepare the release." }],
            },
            {
              id: "chrome-reply",
              type: "agentMessage",
              phase: "final_answer",
              text: "The workspace review is complete. All content shares a centered reading column.\n\n- Keep the conversation easy to scan.\n- Preserve drafts and settings across layout changes.",
            },
          ],
        },
      ],
    }),
    fingerprint: () => "chrome-fixture",
  });
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "host/thread/history" && call.params?.threadId === "old-alpha")
      await route.fulfill({ json: { type: "rpc/result", id: call.id, result: await history.read(call.params) } });
    else await route.continue();
  });
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.body.classList.contains("session-layout"));
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".native-turn-timeline").waitFor();
  await page.locator("#prompt").fill("A draft that must survive appearance and layout changes");
  const title = await page.locator("#threadTitle").textContent();
  const resize = page.locator("#workspaceSidebarResize");
  await resize.waitFor({ state: "visible" });
  assert.equal(await resize.getAttribute("aria-valuenow"), "264");
  const dragSidebar = async (destination) => {
    const box = await resize.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(destination, box.y + 40, { steps: 8 });
    await page.mouse.up();
  };
  await dragSidebar(1400);
  assert.equal(await resize.getAttribute("aria-valuenow"), "360");
  await dragSidebar(0);
  assert.equal(await resize.getAttribute("aria-valuenow"), "224");
  await resize.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await resize.getAttribute("aria-valuenow"), "232");
  await page.keyboard.press("End");
  assert.equal(await resize.getAttribute("aria-valuenow"), "360");
  await resize.dblclick();
  assert.equal(await resize.getAttribute("aria-valuenow"), "264");
  await resize.focus();
  await page.keyboard.press("ArrowRight");
  await page.locator('#sidebar [data-wb="route"][data-route="tasks"]').first().click();
  await page.locator('[data-wb="task"][data-id="old-alpha"]').first().click();
  await page.locator(".native-turn-timeline").waitFor();
  assert.equal(
    await page.locator("#threadTitle").textContent(),
    title,
    "Reopening the active conversation restores its actual title",
  );
  const menu = (name) => page.locator(`[data-chrome-menu="${name}"]`).click();
  const action = (name, value) => page.locator(`[data-chrome-action="${name}"][data-value="${value}"]`).click();
  const align = async (name) => {
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#app")
          .getAnimations()
          .some((animation) => animation.playState === "running"),
    );
    const result = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.x, width: r.width, right: r.right };
      };
      return {
        title: rect("#workspaceContextHeader"),
        composer: rect(".composer-dock"),
        message: rect("#conversation > .native-turn-timeline"),
        shell: rect(".conversation-shell"),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(result.overflow, false, name + JSON.stringify(result));
    for (const key of ["title", "message"]) {
      assert.ok(Math.abs(result[key].x - result.composer.x) < 2, name + JSON.stringify(result));
      assert.ok(Math.abs(result[key].width - result.composer.width) < 2, name + JSON.stringify(result));
    }
    assert.ok(
      Math.abs((result.shell.x + result.shell.right) / 2 - (result.composer.x + result.composer.right) / 2) < 2,
      name + JSON.stringify(result),
    );
  };
  assert.equal(await page.locator(".topbar #threadTitle").count(), 0);
  for (const width of [2560, 2048, 1600, 1280, 1081, 1024, 820, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["comfortable", "wide", "fill"]) {
      await menu("layout");
      const popover = await page.locator("#workbenchPreferences").boundingBox();
      const anchor = await page.locator('[data-chrome-menu="layout"]').boundingBox();
      assert.ok(Math.abs(popover.y - (anchor.y + anchor.height + 12)) < 2);
      assert.ok(popover.x >= 0 && popover.x + popover.width <= width);
      await action("width", mode);
      await align(`${width}-${mode}`);
      const reading = await page.evaluate(() => ({
        rail: document.querySelector(".composer-dock").getBoundingClientRect().width,
        shell: document.querySelector(".conversation-shell").getBoundingClientRect().width,
        gutter: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pf-page-padding-inline")),
      }));
      const expectedRail = Math.min(mode === "comfortable" ? 800 : reading.shell, reading.shell - reading.gutter * 2);
      assert.ok(Math.abs(reading.rail - expectedRail) < 2, `${width}-${mode}: ${JSON.stringify(reading)}`);
      if (width === 2048) await page.screenshot({ path: `${directory}/conversation-${mode}-2048.png` });
      const frame = await page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, width: r.width, right: r.right };
        };
        return { app: box("#app"), header: box(".topbar"), sidebar: box("#sidebar") };
      });
      const expected = Math.min(
        mode === "comfortable" ? 1480 : mode === "wide" ? 1800 : width,
        width - (mode === "comfortable" ? 36 : mode === "wide" ? 48 : 24),
      );
      assert.ok(Math.abs(frame.app.width - expected) < 2, JSON.stringify(frame));
      assert.ok(Math.abs(frame.app.x - (width - expected) / 2) < 2, JSON.stringify(frame));
      assert.ok(Math.abs(frame.header.x - frame.app.x) <= 1, JSON.stringify(frame));
      assert.ok(Math.abs(frame.header.right - frame.app.right) <= 1, JSON.stringify(frame));
      assert.ok(Math.abs(frame.sidebar.x - frame.header.x) < 2, JSON.stringify(frame));
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await menu("layout");
  await action("width", "comfortable");
  for (const preset of ["light", "dark", "silk", "aurora"]) {
    await menu("appearance");
    await action("theme", preset);
    assert.equal(await page.locator("#themeSelect").inputValue(), preset);
    assert.equal(await page.locator("#prompt").inputValue(), "A draft that must survive appearance and layout changes");
    await page.screenshot({ path: `${directory}/desktop-${preset}.png` });
  }
  await menu("appearance");
  await action("theme", "light");
  await menu("language");
  await action("locale", "zh-CN");
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.equal(await page.locator("#threadTitle").textContent(), title);
  await page.screenshot({ path: `${directory}/desktop-zh.png` });
  await menu("language");
  await action("locale", "en");
  await menu("layout");
  await action("focus", "");
  assert.equal(await page.locator("#sessionInspector").isVisible(), false);
  assert.equal(await page.locator("#sidebar").isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-sidebar-open")), null);
  await align("focus");
  await page.locator("#workbenchExitFocus").click();
  assert.equal(await page.locator("#sessionInspector").isVisible(), true);
  await page.locator("#sidebar").waitFor({ state: "visible" });
  await page.locator("#toggleSidebar").click();
  await align("navigation-hidden");
  await page.locator("#workspaceNavigationToggle").click();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await menu("fullscreen");
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await menu("fullscreen");
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  await menu("appearance");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#workbenchPreferences").isVisible(), false);
  assert.equal(
    await page.locator('[data-chrome-menu="appearance"]').evaluate((button) => button === document.activeElement),
    true,
  );
  await menu("layout");
  await action("width", "wide");
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.locator(".workbench-chrome").waitFor({ state: "visible" });
  assert.equal(await page.locator("html").getAttribute("data-workbench-width"), "wide");
  assert.equal(await resize.getAttribute("aria-valuenow"), "272");
  await resize.dblclick();
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".native-turn-timeline").waitFor();
  for (const width of [390, 320, 767]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.locator(".workspace-sidebar-resizer:visible").count(), 0);
    await page.locator(".window-brand").waitFor({ state: "visible" });
    await page.locator("#workspaceNavigationToggle").click();
    await page.locator("#sidebar.mobile-open").waitFor({ state: "visible" });
    await page.locator("#workspaceNavigationToggle").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("mobile-open"));
    await align(`mobile-${width}`);
    const heading = await page.locator("#threadTitle").boundingBox();
    const actions = await page.locator(".workspace-context-actions").boundingBox();
    assert.ok(heading.x < actions.x, "Mobile session actions follow the heading");
    await menu("preferences");
    assert.equal(await page.locator("#workbenchPreferences").evaluate((dialog) => dialog.matches(":modal")), true);
    await action("menu", "appearance");
    await action("theme", "silk");
    assert.equal(await page.locator("html").getAttribute("data-appearance"), "silk");
    await menu("preferences");
    await action("menu", "language");
    await page.screenshot({ path: `${directory}/mobile-${width}-language.png` });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${directory}/mobile-${width}.png` });
  }
  await page.setViewportSize({ width: 2048, height: 1180 });
  await menu("appearance");
  await action("theme", "aurora");
  await page.goto(fixture.base + "/skills/writing");
  await page.locator(".template-card").first().waitFor();
  for (const mode of ["comfortable", "wide", "fill"]) {
    await menu("layout");
    await action("width", mode);
    const geometry = await page.evaluate(() => {
      const left = document.querySelector(".skills-navigation").getBoundingClientRect();
      const right = document.querySelector(".skills-main").getBoundingClientRect();
      const sidebar = document.querySelector("#sidebar").getBoundingClientRect();
      const app = document.querySelector("#app").getBoundingClientRect();
      return { leftGap: left.x - sidebar.right, rightGap: app.right - right.right };
    });
    assert.ok(geometry.leftGap <= 50 && geometry.leftGap >= 46, JSON.stringify(geometry));
    assert.ok(geometry.rightGap <= 68 && geometry.rightGap >= 46, JSON.stringify(geometry));
    await page.screenshot({ path: `${directory}/skills-${mode}-2048.png` });
  }
  await page.locator("[data-template-menu] summary").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-template-menu]").getAttribute("open"), null);
  await page.locator("[data-template-search]").fill("absent-template-for-layout-review");
  await page.locator(".template-empty [data-template-action=clear-filters]").click();
  await page.locator(".template-card").first().waitFor();
  assert.equal(await page.locator("[data-template-search]").inputValue(), "");
  await menu("profile");
  await action("settings", "general-settings");
  await page.locator(".topbar").waitFor({ state: "visible" });
  const settings = await page.locator(".settings-dialog").boundingBox();
  const app = await page.locator("#app").boundingBox();
  assert.ok(Math.abs(settings.x - app.x) < 2 && Math.abs(settings.width - app.width) < 2);
  const settingsResize = page.locator("#settingsSidebarResize");
  await settingsResize.focus();
  await page.keyboard.press("End");
  assert.equal(await settingsResize.getAttribute("aria-valuenow"), "360");
  const settingsGeometry = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const nav = rect(".settings-nav"),
      content = rect("#settingsContent"),
      dialog = rect("#settingsDialog");
    return {
      navWidth: nav.width,
      navTop: nav.top,
      contentTop: content.top,
      dialogTop: dialog.top,
      navHeight: nav.height,
      dialogHeight: dialog.height,
      headingGap: rect(".settings-page-heading").x - nav.right,
      brandWidth: rect(".window-brand").width,
    };
  });
  assert.ok(Math.abs(settingsGeometry.navTop - settingsGeometry.dialogTop) < 2, JSON.stringify(settingsGeometry));
  assert.ok(Math.abs(settingsGeometry.contentTop - settingsGeometry.dialogTop) < 2, JSON.stringify(settingsGeometry));
  assert.ok(Math.abs(settingsGeometry.navHeight - settingsGeometry.dialogHeight) < 2, JSON.stringify(settingsGeometry));
  assert.equal(settingsGeometry.navWidth, 360);
  assert.equal(settingsGeometry.brandWidth, 360);
  assert.equal(settingsGeometry.headingGap, 48);
  await settingsResize.dblclick();
  const fullSettings = await page.locator(".settings-page:visible").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    parent: node.parentElement.getBoundingClientRect().width,
  }));
  assert.ok(Math.abs(fullSettings.width - fullSettings.parent) < 2, JSON.stringify(fullSettings));
  await page.screenshot({ path: `${directory}/settings-fill-2048.png` });
  assert.equal(await page.locator("[data-preference-section]").count(), 4);
  await page.locator("#settingsSearch").fill("notifications");
  await page.locator('[data-preferences-result="notifications"]').click();
  assert.equal(
    await page.locator("#settings-notifications-heading").evaluate((node) => node === document.activeElement),
    true,
  );
  await page.locator('[data-preferences-jump="appearance"]').click();
  await page.locator("#clearSettingsSearch").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#settingsMobileBack").click();
  await page.locator("#settingsSearch").fill("language");
  await page.locator('[data-preferences-result="appearance"]').click();
  const field = await page.locator("#languageSelect").evaluate((select) => {
    const control = select.getBoundingClientRect(),
      row = select.closest("label").getBoundingClientRect(),
      caption = select.closest("label").querySelector("span").getBoundingClientRect();
    return {
      width: control.width,
      rowWidth: row.width,
      height: control.height,
      y: control.y,
      captionBottom: caption.bottom,
    };
  });
  assert.ok(Math.abs(field.width - field.rowWidth) < 2 && field.height >= 44 && field.y >= field.captionBottom);
  const back = await page.locator("#settingsMobileBack").boundingBox();
  assert.ok(back.y >= 56 && back.y < 110, "Mobile back navigation remains visible after jumping to a section");
  await page.screenshot({ path: `${directory}/settings-390.png` });
  await page.goto(fixture.base + "/publish/x");
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.locator(".template-card").first().waitFor();
  const scroller = page.locator("#workbenchView");
  const scrollState = await scroller.evaluate((node) => ({
    rail: getComputedStyle(node).scrollbarWidth,
    overflow: node.scrollHeight > node.clientHeight,
    outer: document.documentElement.scrollHeight > innerHeight,
  }));
  assert.deepEqual(scrollState, { rail: "none", overflow: true, outer: false });
  await scroller.focus();
  await page.keyboard.press("PageDown");
  await page.waitForFunction(() => document.querySelector("#workbenchView").scrollTop > 50);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await scroller.hover({ position: { x: 50, y: 150 } });
  await page.mouse.wheel(0, 450);
  await page.waitForFunction(() => document.querySelector("#workbenchView").scrollTop > 50);
  await page.screenshot({ path: `${directory}/publish-scroll-1440.png` });
  for (const width of [1440, 1024, 767, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const [route, name] of [
      ["/workspace", "workspace"],
      ["/bots", "bots"],
      ["/tasks", "sessions"],
      ["/projects", "projects"],
      ["/create", "create"],
      ["/skills/writing", "skills"],
      ["/publish", "publish"],
    ]) {
      await page.goto(fixture.base + route);
      await page
        .locator(".workbench-view:not([hidden])")
        .waitFor()
        .catch(async (error) => {
          console.error("Page gutter route unavailable", {
            route,
            width,
            url: page.url(),
            body: await page.locator("body").innerText(),
          });
          throw error;
        });
      await page.waitForFunction(() => document.querySelector("#workbenchContent").children.length > 0);
      assert.equal(await page.locator("#workbenchGlobalTitle").count(), 0, `${name}-${width}: no repeated bar title`);
      const geometry = await page.evaluate(() => {
        const view = document.querySelector(".workbench-view"),
          content = document.querySelector("#workbenchContent");
        const parent = view.getBoundingClientRect(),
          child = content.getBoundingClientRect();
        return {
          gap: child.x - parent.x,
          expected: innerWidth <= 767 ? 24 : innerWidth <= 1100 ? 36 : 48,
          top: parseFloat(getComputedStyle(view).paddingTop),
          expectedTop: innerWidth <= 767 ? 16 : 24,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(geometry.gap, geometry.expected, `${name}-${width}: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.top, geometry.expectedTop, `${name}-${width}: vertical spacing is preserved`);
      assert.equal(geometry.overflow, false, `${name}-${width}`);
      if (width === 1440 || width === 390) await page.screenshot({ path: `${directory}/gutter-${name}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Workbench chrome: responsive rails, anchored menus, mobile sheets, focus restoration, persisted width, canonical theme/locale and draft preservation passed.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
