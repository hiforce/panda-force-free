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
const directory = ".artifacts/workbench-shell-implementation";
await mkdir(directory, { recursive: true });
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "light",
    locale: "en",
  });
  await fixture.signIn(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
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
  for (const width of [1600, 1280, 1081, 1024, 820, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["comfortable", "wide", "fill"]) {
      await menu("layout");
      const popover = await page.locator("#workbenchPreferences").boundingBox();
      const anchor = await page.locator('[data-chrome-menu="layout"]').boundingBox();
      assert.ok(Math.abs(popover.y - (anchor.y + anchor.height + 12)) < 2);
      assert.ok(popover.x >= 0 && popover.x + popover.width <= width);
      await action("width", mode);
      await align(`${width}-${mode}`);
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
  assert.equal(await page.locator("html").getAttribute("data-workbench-width"), "wide");
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".native-turn-timeline").waitFor();
  for (const width of [390, 320, 767]) {
    await page.setViewportSize({ width, height: 844 });
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
  assert.deepEqual(errors, []);
  console.log(
    "Workbench chrome: responsive rails, anchored menus, mobile sheets, focus restoration, persisted width, canonical theme/locale and draft preservation passed.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
