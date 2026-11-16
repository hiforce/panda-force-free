import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { localAuthFixture } from "../support/local-auth-fixture.mjs";
import { smtpFixture } from "../support/smtp-fixture.ts";
import { SQLiteLocalUsers } from "../../src/server/auth/users/sqlite.ts";
import { artifact } from "../support/browser-runtime.mjs";
const results = [];
const currentPassword = { value: "Browser-initial-123" };
const cookie = (r) => r.headers.get("set-cookie").split(";")[0];
for (const [engine, width] of [
  [chromium, 1440],
  [webkit, 390],
]) {
  const mail = await smtpFixture(),
    f = await localAuthFixture();
  let browser;
  try {
    const password = "Browser-initial-123";
    currentPassword.value = password;
    const root = cookie(await f.post("/api/auth/setup", { username: "rocky", password }));
    assert.equal(
      (
        await fetch(f.base + "/api/local-users/mail", {
          method: "PUT",
          headers: { origin: f.base, cookie: root, "content-type": "application/json" },
          body: JSON.stringify({ ...mail.config, publicUrl: f.base, revision: 0 }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.post(
          "/api/local-users/email",
          { email: "root@example.com", operationId: crypto.randomUUID() },
          { cookie: root },
        )
      ).status,
      202,
    );
    for (let n = 0; n < 200 && mail.messages.length < 1; n++) await Bun.sleep(30);
    const binding = new URLSearchParams(
      new URL(mail.messages[0].html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&")).hash.slice(1),
    ).get("token");
    assert.equal((await f.post("/api/local-users/email/confirm", { token: binding })).status, 200);
    browser = await engine.launch({ headless: true });
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      // Advancing only the fixture's prior request time allows independent rendered scenarios without real mail or waiting.
      const repository = new SQLiteLocalUsers(join(f.dir, ".panda-force/data/users.sqlite"));
      const settings = repository.settings();
      if (settings.recoveryRequest)
        repository.saveSettings(
          {
            ...settings,
            revision: settings.revision + 1,
            recoveryRequest: { ...settings.recoveryRequest, at: Date.now() - 61000 },
          },
          settings.revision,
        );
      repository.close();
      const ctx = await browser.newContext({
        viewport: { width, height: 960 },
        isMobile: width < 768,
        hasTouch: width < 768,
        colorScheme: width < 768 ? "dark" : "light",
      });
      await ctx.addCookies([{ name: "panda-force-locale", value: locale, url: f.base }]);
      await ctx.addInitScript((theme) => {
        if (window === window.top) localStorage.setItem("panda-force-theme", theme);
      }, { en: "light", "zh-CN": "aurora", "zh-HK": "dark", "zh-TW": "silk" }[locale]);
      const page = await ctx.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.base + "/reset-password");
      await page.locator("#recovery-identifier").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
      await page.locator("#recovery-identifier").fill("rocky");
      if (locale === "en") {
        await page.route(f.base + "/api/local-users/reset/request", (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "users.unavailable" }),
          }),
        );
        await page.locator("[data-email-onboarding] button[type=submit]").click();
        await page.locator("[data-email-onboarding-status][data-state=error]").waitFor();
        assert.equal(await page.locator("#recovery-identifier").inputValue(), "rocky");
        await page.unroute(f.base + "/api/local-users/reset/request");
      }
      const count = mail.messages.length;
      let requests = 0;
      await page.route(f.base + "/api/local-users/reset/request", async (route) => {
        requests++;
        await new Promise((r) => setTimeout(r, 400));
        await route.continue();
      });
      await page.locator("[data-email-onboarding]").evaluate((form) => {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      await page.locator("[data-email-onboarding-status][data-state=pending]").waitFor();
      assert.equal(await page.locator("[data-email-onboarding] button[type=submit]").isDisabled(), true);
      await page.locator("#recovery-code").waitFor();
      assert.equal(requests, 1);
      assert.equal(await page.locator("[data-code-cell]").count(), 6);
      assert.equal(await page.locator("#recovery-code").getAttribute("autocomplete"), "one-time-code");
      assert.equal(await page.locator("[data-recovery-resend]").isDisabled(), true);
      assert.ok((await page.locator("[data-recovery-resend]").innerText()).match(/[0-9]+/));
      for (let n = 0; n < 200 && mail.messages.length <= count; n++) await Bun.sleep(30);
      assert.equal(mail.messages.length, count + 1);
      const html = mail.messages.at(-1).html;
      assert.equal(html.includes("href="), false);
      const code = html.match(/data-verification-code>([0-9]{6})</)[1];
      await page.screenshot({ path: artifact(`recovery-code-${locale}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.reload();
      await page.locator("#recovery-code").waitFor();
      assert.equal(await page.locator("[data-recovery-resend]").isDisabled(), true);
      await page.locator("#recovery-code").fill(code === "000000" ? "111111" : "000000");
      await page.locator("[data-email-onboarding-status][data-state=error]").waitFor();
      assert.equal(await page.locator("#recovery-code").getAttribute("aria-invalid"), "true");
      await page.locator("#recovery-code").fill("");
      await page.locator("#recovery-code").focus();
      await page.keyboard.insertText(code);
      await page.locator("#recovery-password").waitFor();
      assert.equal(new URL(page.url()).pathname, "/reset-password/new");
      assert.equal(await page.evaluate(() => location.hash), "");
      await page.screenshot({ path: artifact(`recovery-password-${locale}-${width}.png`) });
      await page.locator("#recovery-password").fill("Changed-browser-123");
      await page.goBack();
      await page.locator("#recovery-code").waitFor();
      if (locale === "zh-TW" && width === 390) {
        await page.setViewportSize({ width: 320, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: artifact("recovery-code-320.png") });
        await page.setViewportSize({ width: 390, height: 960 });
      }
      await page.goForward();
      await page.locator("#recovery-password").waitFor();
      assert.equal(await page.locator("#recovery-password").inputValue(), "Changed-browser-123");
      const nextPassword = "Changed-browser-" + locale + "-123";
      await page.locator("#recovery-password").fill(nextPassword);
      await page.locator("#recovery-confirm").fill(nextPassword);
      await page.locator("[data-email-onboarding] button[type=submit]").click();
      await page.locator(".auth-recovery-login").waitFor();
      const labels = { en: "Back to sign in", "zh-CN": "返回登录", "zh-HK": "返回登入", "zh-TW": "返回登入" };
      assert.equal(await page.locator(".auth-recovery-login").innerText(), labels[locale]);
      assert.equal(await page.locator("#passwordGate a:visible").count(), 1);
      for (const selector of [
        ".auth-symbol",
        ".auth-eyebrow",
        ".auth-account-note",
        ".auth-footer",
        "[data-email-onboarding-back]",
      ])
        assert.equal(await page.locator(selector).isVisible(), false);
      assert.equal(await page.locator(".auth-email-success").isVisible(), true);
      assert.equal(await page.locator(".auth-recovery-login").evaluate((el) => el === document.activeElement), true);
      const geometry = await page.evaluate(() => {
        const gate = document.querySelector("#passwordGate"),
          card = gate.querySelector(".password-login-card").getBoundingClientRect(),
          brand = gate.querySelector(".auth-brand").getBoundingClientRect(),
          button = gate.querySelector(".auth-recovery-login"),
          box = button.getBoundingClientRect(),
          style = getComputedStyle(button);
        const luminance = (color) => {
          const values = color
            .match(/[0-9.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return {
          topGap: card.top - brand.bottom,
          bottom: card.bottom,
          buttonHeight: box.height,
          contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(geometry.topGap <= 100);
      assert.ok(geometry.bottom < 960);
      assert.ok(geometry.buttonHeight >= 44);
      assert.ok(geometry.contrast >= 4.5);
      assert.equal(geometry.overflow, false);
      const alternate = locale === "en" ? "zh-CN" : "en";
      await page.evaluate((locale) => window.__pandaForceI18n.setPreference(locale), alternate);
      assert.equal(await page.locator(".auth-recovery-login").innerText(), labels[alternate]);
      await page.evaluate((locale) => window.__pandaForceI18n.setPreference(locale), locale);
      assert.equal(await page.locator(".auth-recovery-login").innerText(), labels[locale]);
      await page.screenshot({ path: artifact(`recovery-complete-${locale}-${width}.png`) });
      if (locale === "zh-CN" && width === 390) {
        await page.setViewportSize({ width: 320, height: 568 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: artifact("recovery-complete-320.png") });
        await page.setViewportSize({ width: 390, height: 960 });
      }
      assert.equal(
        (await f.post("/api/auth/login", { username: "rocky", password: currentPassword.value })).status,
        401,
      );
      assert.equal((await f.post("/api/auth/login", { username: "rocky", password: nextPassword })).status, 200);
      currentPassword.value = nextPassword;
      await page.keyboard.press("Enter");
      await page.locator("#passwordLoginButton").waitFor();
      assert.equal(await page.locator("html").getAttribute("lang"), locale);
      assert.equal(await page.locator("#passwordInput").isVisible(), true);
      assert.deepEqual(errors, []);
      results.push({
        engine: engine.name(),
        width,
        locale,
        sixCells: true,
        immediateFeedback: true,
        coalescedSend: true,
        cooldownSurvivesReload: true,
        invalidCodeFeedback: true,
        numericPaste: true,
        verifiedPasswordPage: true,
        backPreservesPassword: true,
        noOverflow: true,
        pageErrors: 0,
      });
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await f.dispose();
    await mail.close();
  }
}
await Bun.write(artifact("recovery-browser.private.json"), JSON.stringify(results, null, 2));
console.log({ passed: true, pcH5Locales: results.length, realLocalSmtp: true, realPasswordChange: true });
