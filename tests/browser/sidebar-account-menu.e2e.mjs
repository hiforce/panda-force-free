import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const screenshots = process.env.PANDA_SIDEBAR_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const locales = [
  {
    locale: "en",
    settings: "Settings",
    account: "Account",
    logout: "Log out",
    failed: "Could not log out. Try again.",
    width: 1440,
  },
  {
    locale: "zh-CN",
    settings: "设置",
    account: "账户",
    logout: "退出登录",
    failed: "退出登录失败，请重试。",
    width: 1280,
  },
  { locale: "zh-HK", settings: "設定", account: "帳戶", logout: "登出", failed: "未能登出，請再試一次。", width: 390 },
  { locale: "zh-TW", settings: "設定", account: "帳號", logout: "登出", failed: "無法登出，請重試。", width: 320 },
];
for (const { locale, settings, account, logout, failed, width } of locales) {
  const app = await createAppFixture({ startupTimeoutMs: 60000 });
  const mobile = width < 768;
  const browser = await (mobile ? webkit : chromium).launch();
  try {
    const context = await browser.newContext({
      locale,
      viewport: { width, height: 844 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    await app.signIn(context);
    await context.addInitScript((locale) => {
      if (window === window.top) localStorage.setItem("panda-force-locale", locale);
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const activate = (locator) => (mobile ? locator.tap() : locator.click());
    await page.goto(app.base + "/new");
    try {
      await page.locator('[data-chrome-menu="profile"]').waitFor({ state: "attached" });
    } catch (error) {
      throw new Error(
        `Shell failed for ${locale} at ${page.url()}. ${errors.join(" · ")} ${await page.locator("body").innerText()}`,
        { cause: error },
      );
    }
    const prep = page.locator("#workspacePreparationContinue");
    try {
      if (await prep.isVisible()) await prep.click({ timeout: 2000 });
    } catch (error) {
      if (await prep.isVisible()) throw error;
    }
    const returnTo = page.url();
    const openSidebar = async () => {
      if (mobile) await activate(page.locator("#workspaceNavigationToggle"));
    };
    const footer = page.locator(".sidebar-footer");
    const settingsEntry = footer.getByRole("button", { name: settings, exact: true });
    await openSidebar();
    await settingsEntry.waitFor();
    assert.equal(await footer.locator("#accountButton, #sidebarHelpButton, #workbenchConnection").count(), 0);
    assert.equal(await settingsEntry.locator('[data-icon="settings"] svg').count(), 1);
    assert((await settingsEntry.boundingBox()).height >= 44);
    if (screenshots)
      await page.screenshot({ animations: "disabled", path: join(screenshots, `sidebar-${locale}.png`) });
    if (mobile) await activate(settingsEntry);
    else {
      await settingsEntry.focus();
      await page.keyboard.press("Enter");
    }
    await page.waitForURL("**/settings/general-settings");
    await page.locator("#settingsDialog[open]").waitFor();
    await activate(page.locator("#closeSettingsNav"));
    await page.waitForURL(returnTo);
    if (mobile && (await footer.isVisible())) await page.keyboard.press("Escape");
    const accountTrigger = page.locator(".top-actions").getByRole("button", { name: account, exact: true });
    const menu = page.getByRole("dialog", { name: account, exact: true });
    await activate(accountTrigger);
    await menu.waitFor();
    const logoutEntry = menu.getByRole("button", { name: logout, exact: true });
    assert(
      await logoutEntry.evaluate(
        (button) =>
          button === button.parentElement.lastElementChild &&
          button.previousElementSibling.getAttribute("role") === "separator",
      ),
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (mobile) {
      const topbar = page.locator(".topbar");
      const mark = await topbar.locator("#windowCodexMark").boundingBox();
      const actions = await topbar.locator(".top-actions").boundingBox();
      assert(mark.x + mark.width <= actions.x);
      if (width <= 375)
        assert.equal(
          await topbar.locator(".window-brand strong").evaluate((text) => getComputedStyle(text).clipPath),
          "inset(50%)",
        );
    }
    if (screenshots)
      await page.screenshot({ animations: "disabled", path: join(screenshots, `account-${locale}.png`) });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert(await accountTrigger.evaluate((trigger) => document.activeElement === trigger));
    let logoutRequests = 0;
    await page.route("**/api/auth/logout", async (route) => {
      logoutRequests++;
      if (logoutRequests > 1) return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 450));
      return route.fulfill({ status: 503 });
    });
    await activate(accountTrigger);
    await activate(logoutEntry);
    await menu.locator('[data-chrome-action="logout"]:disabled').waitFor();
    await menu.getByRole("alert").filter({ hasText: failed }).waitFor();
    assert.equal(logoutRequests, 1);
    assert(await logoutEntry.evaluate((button) => document.activeElement === button));
    await activate(logoutEntry);
    await page.locator("#passwordGate:not([hidden])").waitFor();
    assert.equal(logoutRequests, 2);
    assert.equal((await context.request.get(app.base + "/api/config")).status(), 401);
    assert.deepEqual(errors, []);
    console.log(`${locale} ${width}: direct settings, account separator, logout recovery and sign-out verified`);
  } finally {
    await browser.close();
    await app.dispose();
  }
}
