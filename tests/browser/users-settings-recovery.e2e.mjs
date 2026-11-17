import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createBrowserFixture, artifact } from "../support/browser-runtime.mjs";

const f = await createBrowserFixture();
const results = [];
try {
  for (const [engine, width, locale, failingPath, recovery] of [
    [chromium, 1440, "en", "/api/local-users/self", "automatic"],
    [webkit, 430, "zh-CN", "/api/local-users/mail", "retry"],
    [webkit, 390, "zh-HK", "/api/local-users", "automatic"],
    [webkit, 320, "zh-TW", "/api/local-users/self", "retry"],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 932 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await f.signIn(context);
      await context.addCookies([{ name: "panda-force-locale", value: locale, url: f.base }]);
      await context.addInitScript((language) => {
        if (window === window.top && /^https?:$/.test(location.protocol))
          localStorage.setItem("panda-force-locale", language);
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let failures = 1,
        mailRequests = 0,
        writes = 0,
        failedPath = failingPath;
      await page.route(f.base + "/api/local-users{,/**}", async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (request.method() !== "GET") writes++;
        if (path === "/api/local-users/mail") mailRequests++;
        if (path === failedPath && failures > 0) {
          failures--;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Account service is temporarily unavailable. Please retry.",
              messageId: "users.unavailable",
            }),
          });
        }
        await route.continue();
      });
      await page.goto(f.base + "/settings/users");
      const retry = page.locator("[data-users-retry]");
      await retry.waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("[data-users-retry]")?.disabled);
      assert.equal(await page.locator("[data-users-mail]").count(), 0);
      const copy = await Bun.file(
        new URL(`../../src/shared/i18n/locales/${locale}/users.json`, import.meta.url),
      ).json();
      assert.equal(await page.locator("[data-users-notice]").textContent(), copy.unavailable);
      await page.screenshot({ path: artifact(`users-load-error-${locale}-${width}.png`) });
      if (recovery === "retry") await retry.click();
      await page.locator("[data-users-mail]").waitFor({ timeout: 14000 });
      assert.equal(new URL(page.url()).pathname, "/settings/users");
      assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
      const host = page.locator('[data-users-mail] [name="host"]'),
        password = page.locator('[data-users-mail] [name="password"]'),
        invitation = page.locator('[data-users-invite] [name="email"]');
      await host.fill("retained.example.com");
      await password.fill("Unsubmitted-test-secret");
      await invitation.fill("draft@example.com");
      const readMail = mailRequests;
      failedPath = "/api/local-users/self";
      failures = 1;
      await page.locator("[data-users-notice]").filter({ hasText: /.+/ }).waitFor({ timeout: 12000 });
      await page.waitForFunction(() => !document.querySelector("[data-users-notice]")?.textContent, undefined, {
        timeout: 12000,
      });
      assert.equal(await host.inputValue(), "retained.example.com");
      assert.equal(await password.inputValue(), "Unsubmitted-test-secret");
      assert.equal(await invitation.inputValue(), "draft@example.com");
      assert.equal(
        mailRequests,
        readMail,
        "Background member refresh must not silently advance the SMTP revision behind a draft",
      );
      assert.equal(writes, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await password.fill("");
      await page.evaluate(() => {
        document.activeElement?.blur();
        for (let node = document.querySelector("[data-users-mail]"); node; node = node.parentElement)
          node.scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(150);
      await page.screenshot({ path: artifact(`users-load-recovered-${locale}-${width}.png`) });
      assert.deepEqual(errors, []);
      results.push({
        locale,
        width,
        recovery,
        initialFailure: failingPath,
        draftRetained: true,
        smtpDraftRevisionRetained: true,
        writes,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 932 }, isMobile: true, hasTouch: true });
    await f.signIn(context);
    const page = await context.newPage();
    let count = 0,
      release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route(f.base + "/api/local-users/self", async (route) => {
      count++;
      if (count === 1) await held;
      try {
        await route.continue();
      } catch {
        /* A timed out read has already been canceled. */
      }
    });
    await page.goto(f.base + "/settings/users");
    await page.waitForTimeout(6200);
    assert.equal(count, 1, "Five-second refresh must coalesce with the unfinished first read");
    await page.waitForFunction(
      () => {
        const retry = document.querySelector("[data-users-retry]");
        return Boolean(document.querySelector("[data-users-mail]") || (retry && !retry.hidden && !retry.disabled));
      },
      undefined,
      { timeout: 6000 },
    );
    if (!(await page.locator("[data-users-mail]").count())) await page.locator("[data-users-retry]").click();
    await page.locator("[data-users-mail]").waitFor({ timeout: 6000 });
    assert.equal(count, 2);
    release();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-users-mail]").count(), 1);
    results.push({
      width: 390,
      timedOutInitialRead: true,
      mergedPolling: true,
      recoveredWithoutReload: true,
      reads: count,
    });
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await f.dispose();
}
