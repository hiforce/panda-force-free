import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";

const fixture = await createBrowserFixture();
const browser = await fixture.launchBrowser(launchOptions());
const directory = ".artifacts/session-dialogs";
await mkdir(directory, { recursive: true });
const measurements = [],
  errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1861, height: 888 }, colorScheme: "light" });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("panda-force-theme", "light");
    const native = window.visualViewport;
    const viewport = new EventTarget();
    for (const name of ["width", "height", "scale", "offsetTop", "offsetLeft"])
      Object.defineProperty(viewport, name, { get: () => viewport["_" + name] ?? native[name] });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    window.__dialogViewport = viewport;
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
  await page.locator("#prompt").fill("Keep the draft while reviewing settings.");
  const inspect = async (id, label, mobileSheet = true) => {
    const dialog = page.locator(id);
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => Math.abs(document.querySelector("#app").getBoundingClientRect().height - visualViewport.height) <= 1,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await dialog.evaluate((element) => {
      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      };
      return {
        dialog: rect(element),
        viewport: { width: innerWidth, top: visualViewport.offsetTop, height: visualViewport.height },
        modal: element.matches(":modal"),
        heading: element.querySelector("header") ? rect(element.querySelector("header")) : null,
        footer: element.querySelector(".session-dialog-actions")
          ? rect(element.querySelector(".session-dialog-actions"))
          : null,
        body: element.querySelector(".session-dialog-body")
          ? rect(element.querySelector(".session-dialog-body"))
          : null,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    measurements.push({ label, ...result });
    await page.screenshot({ path: directory + "/" + label + ".png" });
    const { dialog: box, viewport } = result;
    const detail = `${label}: ${JSON.stringify(result)}`;
    assert.equal(result.modal, true, detail);
    assert.equal(result.overflow, false, detail);
    assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 1, detail);
    if (viewport.width >= 768 || !mobileSheet)
      assert.ok(Math.abs(box.y + box.height / 2 - viewport.top - viewport.height / 2) <= 1, detail);
    else assert.ok(Math.abs(box.bottom - viewport.top - viewport.height) <= 1, detail);
    assert.ok(box.y >= viewport.top - 1 && box.bottom <= viewport.top + viewport.height + 1, detail);
    if (result.footer) {
      assert.ok(result.footer.bottom <= box.bottom + 1 && result.footer.y >= box.y, detail);
      assert.ok(result.body.bottom <= result.footer.y + 1, detail);
      for (const button of await dialog.locator(".session-dialog-actions button").all()) {
        const bounds = await button.boundingBox();
        assert.ok(bounds.height >= 44 && bounds.y >= box.y && bounds.y + bounds.height <= box.bottom + 1, detail);
      }
    }
    return result;
  };
  const dismiss = async (id) => {
    await page.keyboard.press("Escape");
    await page.locator(id).waitFor({ state: "hidden" });
  };
  await page.locator("#modelButton").click();
  await inspect("#sessionSettingsDialog", "desktop-model");
  await page.locator("#sessionSettingModel").selectOption("gpt-5.6-luna");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.locator("#sessionSettingsDialog").evaluate((node) => node.contains(document.activeElement)),
    true,
  );
  await dismiss("#sessionSettingsDialog");
  assert.equal(await page.locator("#modelButton").evaluate((node) => document.activeElement === node), true);
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-sol");
  await page.locator("#modelButton").click();
  for (const [width, height] of [
    [1440, 960],
    [1050, 780],
    [820, 900],
    [1280, 430],
    [740, 390],
    [390, 844],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    await inspect("#sessionSettingsDialog", `model-${width}-${height}`);
    assert.equal(await page.locator("#sessionSettingModel").inputValue(), "gpt-5.6-sol");
  }
  await page.evaluate(() => {
    const viewport = window.__dialogViewport;
    viewport._height = 410;
    viewport._offsetTop = 18;
    viewport.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() => Math.abs(document.querySelector("#app").getBoundingClientRect().height - 410) < 1);
  await inspect("#sessionSettingsDialog", "mobile-keyboard-model");
  await page.locator("#sessionSettingModel").selectOption("gpt-5.6-luna");
  await page.locator('input[name="session-effort"][value="high"]').check();
  await page.locator('#sessionSettingsForm button[type="submit"]').click();
  await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-luna");
  assert.equal(await page.locator("#prompt").inputValue(), "Keep the draft while reviewing settings.");
  await page.evaluate(() => {
    const viewport = window.__dialogViewport;
    delete viewport._height;
    delete viewport._offsetTop;
    viewport.dispatchEvent(new Event("resize"));
  });
  await page.setViewportSize({ width: 1861, height: 888 });
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.setPermissionProfiles(
      Array.from({ length: 18 }, (_, index) => ({
        id: "review-policy-" + index,
        description:
          "Review policy " +
          index +
          ": ask before changing files or running commands. Keep approval decisions in this session.",
        allowed: true,
      })),
    ),
  );
  await page.locator("#modeButton").click();
  await inspect("#sessionSettingsDialog", "desktop-permissions-long");
  const scroll = await page.locator("#sessionSettingsDialog .session-dialog-body").evaluate((element) => {
    const scrollable = element.scrollHeight > element.clientHeight;
    const footer = document.querySelector("#sessionSettingsForm .session-dialog-actions");
    const before = footer.getBoundingClientRect().y;
    element.scrollTop = element.scrollHeight;
    return { scrollable, before, after: footer.getBoundingClientRect().y };
  });
  assert.equal(scroll.scrollable, true);
  assert.equal(scroll.before, scroll.after);
  await page.locator('input[name="session-permission"][value="profile:review-policy-17"]').check();
  await page.locator("#sessionSettingsForm [data-settings-dismiss]").click();
  assert.notEqual(
    await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode),
    "profile:review-policy-17",
  );
  await page.locator("#modeButton").click();
  await page.mouse.click(8, 8);
  await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
  await page.locator('#sessionInspector [data-session-action="usage"]').click();
  await inspect("#sessionUsageDialog", "desktop-usage");
  await dismiss("#sessionUsageDialog");
  await page.locator('#sessionInspectorFooter [data-session-action="customize"]').click();
  await inspect("#sessionToolsDialog", "desktop-tools");
  await dismiss("#sessionToolsDialog");
  await page.locator("#sessionActionsButton").click();
  await inspect("#sessionActionsDialog", "desktop-session-actions");
  await dismiss("#sessionActionsDialog");
  await page.locator('#sessionInspector [data-session-action="project"]').click();
  await inspect("#projectDialog", "desktop-project");
  await dismiss("#projectDialog");
  await page.evaluate(() => {
    globalThis.__pandaForceDebug.setPermissionProfiles([]);
    globalThis.__pandaForceDebug.setPermissionVisibility("fullAccess", true);
  });
  await page.locator("#modeButton").click();
  await inspect("#sessionSettingsDialog", "desktop-permissions");
  await page.locator('input[name="session-permission"][value="full-access"]').check();
  await page.locator('#sessionSettingsForm button[type="submit"]').click();
  await inspect("#fullAccessDialog", "desktop-full-access", false);
  await page.locator('#fullAccessDialog button[value="cancel"]').click();
  assert.notEqual(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "full-access");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#modeButton").click();
  await inspect("#sessionSettingsDialog", "mobile-permissions");
  await dismiss("#sessionSettingsDialog");
  await page.locator('#sessionMobileSummary [data-session-action="usage"]').click();
  await inspect("#sessionUsageDialog", "mobile-usage");
  await dismiss("#sessionUsageDialog");
  await page.locator("#sessionActionsButton").click();
  await inspect("#sessionActionsDialog", "mobile-session-actions");
  await dismiss("#sessionActionsDialog");
  await page.locator("#sessionInfoButton").click();
  await page.locator('#sessionInspectorFooter [data-session-action="customize"]').click();
  await inspect("#sessionToolsDialog", "mobile-tools");
  await dismiss("#sessionToolsDialog");
  await page.locator('#sessionInspector [data-session-action="close"]').click();
  await page.setViewportSize({ width: 1861, height: 888 });
  await page.locator("#modelButton").click();
  await page.evaluate(async () => {
    await globalThis.__pandaForceI18n.setPreference("zh-CN");
    const theme = document.querySelector("#themeSelect");
    theme.value = "dark";
    theme.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await inspect("#sessionSettingsDialog", "desktop-model-dark-zh");
  await dismiss("#sessionSettingsDialog");
  assert.deepEqual(errors, []);
  await writeFile(directory + "/measurements.json", JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ dialogsChecked: measurements.length, errors }));
} finally {
  await browser.close();
}
