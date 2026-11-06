import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";

const fixture = await createAppFixture({
  account: { type: "chatgpt", email: "model-fixture@example.invalid", planType: "plus" },
});
let browser;
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
  });
  await fixture.signIn(context);
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("panda-force-locale", "en");
    const state = { permission: "default", requests: 0, notifications: [] };
    globalThis.notificationTest = state;
    window.Notification = class {
      static get permission() {
        return state.permission;
      }
      static requestPermission() {
        state.requests++;
        return new Promise((resolve, reject) => {
          state.decide = (permission) => {
            state.permission = permission;
            resolve(permission);
          };
          state.fail = () => reject(new Error("Permission unavailable"));
        });
      }
      constructor(title, options) {
        state.notifications.push({ title, options });
      }
    };
  });
  const page = await context.newPage(),
    nativeDialogs = [],
    errors = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = async () => {
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.connected);
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  };
  await page.goto(fixture.base + "/workspace");
  await ready();
  assert.equal(await page.evaluate(() => globalThis.notificationTest.requests), 0);
  await fixture.stop();
  await fixture.start();
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.connected);
  assert.equal(await page.evaluate(() => globalThis.notificationTest.requests), 0);
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => globalThis.notificationTest.requests), 0);

  const dialog = page.getByRole("alertdialog");
  const options = page.locator('.thread-item[data-id="old-beta"] .thread-options');
  const openDelete = async () => {
    await options.click();
    await page.getByRole("menuitem", { name: "Delete session", exact: true }).click();
    await dialog.waitFor();
  };
  const calls = (method) => fixture.calls().filter((call) => call.method === method);
  await openDelete();
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.ok((await dialog.innerText()).includes("Old beta session"));
  assert.equal(
    await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });
  assert.equal(calls("thread/delete").length, 0);
  assert.equal(await options.evaluate((el) => el === document.activeElement), true);
  await openDelete();
  await page.evaluate(() => globalThis.__pandaForceDebug.renderThreads());
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await options.evaluate((el) => el === document.activeElement), true);
  assert.equal(calls("thread/delete").length, 0);
  await openDelete();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(calls("thread/delete").length, 0);
  await openDelete();
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: "detached" });
  assert.equal(calls("thread/delete").length, 0);
  await openDelete();
  const widths = await dialog
    .locator("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().width));
  assert.ok(Math.abs(widths[0] - widths[1]) < 1);
  assert.ok(
    (await dialog.getByRole("button", { name: "Delete session", exact: true }).getAttribute("class")).includes(
      "danger",
    ),
  );
  await page.screenshot({ path: artifact("confirmation-delete-desktop.png") });
  await dialog.getByRole("button", { name: "Delete session", exact: true }).click();
  await waitFor(() => calls("thread/delete").length === 1);
  assert.equal(calls("thread/delete")[0].params.threadId, "old-beta");
  await options.waitFor({ state: "detached" });

  console.log("Checking model account cancellation");
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.account?.type === "chatgpt");
  await page.locator("#accountButton").click();
  await page.locator("#accountLogout").click();
  await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes("Your PandaForce login stays active"));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(calls("account/logout").length, 0);
  console.log("Checking model account consent");
  await page.locator("#accountMenu").waitFor({ state: "hidden" });
  await page.locator("#accountButton").click();
  await page.locator("#accountLogout").click();
  await dialog.getByRole("button", { name: "Log out", exact: true }).click();
  await waitFor(() => calls("account/logout").length === 1);
  assert.equal((await (await context.request.get(fixture.base + "/api/auth/status")).json()).authenticated, true);

  await page.evaluate(() => globalThis.__pandaForceDebug.openSettings("general-settings"));
  const toggle = page.locator("#settingsTaskNotifyToggle");
  assert.equal(await toggle.isChecked(), false);
  await page.locator("#settingsTaskNotifyRow").click();
  await page.waitForFunction(() => globalThis.notificationTest.requests === 1);
  assert.equal(await toggle.isDisabled(), true);
  await page.evaluate(() => globalThis.notificationTest.decide("default"));
  await toggle.waitFor();
  await page.waitForFunction(() => !document.querySelector("#settingsTaskNotifyToggle").disabled);
  assert.equal(await toggle.isChecked(), false);
  await page.locator("#settingsTaskNotifyRow").click();
  await page.waitForFunction(() => globalThis.notificationTest.requests === 2);
  await page.evaluate(() => globalThis.notificationTest.decide("denied"));
  await page.waitForFunction(() => !document.querySelector("#settingsTaskNotifyToggle").disabled);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-task-notify")), "false");
  await page.evaluate(() => {
    globalThis.notificationTest.permission = "default";
  });
  await page.locator("#settingsTaskNotifyRow").click();
  await page.waitForFunction(() => globalThis.notificationTest.requests === 3);
  await page.evaluate(() => globalThis.notificationTest.fail());
  await page.waitForFunction(() => !document.querySelector("#settingsTaskNotifyToggle").disabled);
  assert.equal(await toggle.isChecked(), false);
  await page.locator("#settingsTaskNotifyRow").click();
  await page.waitForFunction(() => globalThis.notificationTest.requests === 4);
  await page.evaluate(() => globalThis.notificationTest.decide("granted"));
  await page.waitForFunction(() => !document.querySelector("#settingsTaskNotifyToggle").disabled);
  assert.equal(await toggle.isChecked(), true);
  await page.locator("#settingsTaskNotifyRow").click();
  await page.locator("#settingsTaskNotifyRow").click();
  assert.equal(await page.evaluate(() => globalThis.notificationTest.requests), 4);
  assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-task-notify")), "true");
  await page.evaluate(() => globalThis.__pandaForceDebug.closeSettings());

  await page.evaluate(async () => {
    await globalThis.__pandaForceI18n.setPreference("zh-CN");
    const theme = document.querySelector("#themeSelect");
    theme.value = "dark";
    theme.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("#toggleSidebar").getAttribute("aria-expanded") === "false");
  await page.locator("#workspaceNavigationToggle").click();
  await page.waitForFunction(() => Math.abs(document.querySelector("#sidebar").getBoundingClientRect().left) < 1);
  await page.locator('.thread-item[data-id="old-alpha"] .thread-options').click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("heading").innerText(), "删除会话？");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.screenshot({
    path: artifact("confirmation-delete-mobile-dark-zh.png"),
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(calls("thread/delete").length, 1);
  assert.deepEqual(nativeDialogs, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      brandedConfirmations: true,
      cancelEscapeBackdropAndEnterSafe: true,
      destructiveRequestsExactlyOnce: true,
      modelLogoutKeepsPandaForceLogin: true,
      noNotificationPromptOnStartupReloadOrReconnect: true,
      permissionRequiresToggle: true,
      dismissedDeniedAndFailedPermissionsStayOff: true,
      grantedPermissionReused: true,
      chineseDarkMobile: true,
      nativeDialogs,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
