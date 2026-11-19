import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture({ sharedApprovals: true });
const out = ".artifacts/composer-menu-overlay/screens",
  results = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, height, locale] of [
    [chromium, 1440, 1000, "en"],
    [webkit, 390, 844, "zh-CN"],
    [webkit, 320, 740, "zh-HK"],
    [webkit, 430, 900, "zh-TW"],
    [webkit, 844, 390, "en"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        locale,
        isMobile: engine === webkit,
        hasTouch: engine === webkit,
      });
      await context.addInitScript((locale) => {
        if (!/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "aurora");
        localStorage.setItem("panda-force-permission-full-access", "true");
      }, locale);
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [],
        menus = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.base + "/task/old-alpha");
      await page.locator("#prompt").waitFor();
      await page.goto(app.base + "/new");
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
      const check = async (selector, state) => {
        const menu = page.locator(selector);
        await menu.waitFor();
        const geometry = await menu.evaluate((menu) => {
          const rect = menu.getBoundingClientRect(),
            viewport = window.visualViewport;
          const top = viewport?.offsetTop || 0,
            bottom = top + (viewport?.height || innerHeight);
          const chrome = [...document.querySelectorAll(".workspace-attribution,.workbench-mobile-nav")]
            .filter((e) => e.getClientRects().length)
            .map((e) => e.getBoundingClientRect().top);
          return {
            parent: menu.parentElement.tagName,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            visibleTop: top,
            visibleBottom: Math.min(bottom, ...chrome),
            scrollable: menu.scrollHeight > menu.clientHeight,
            width: innerWidth,
          };
        });
        assert.equal(geometry.parent, "BODY");
        assert(
          geometry.top >= geometry.visibleTop && geometry.bottom <= geometry.visibleBottom + 1,
          JSON.stringify(geometry),
        );
        assert(geometry.left >= 0 && geometry.right <= geometry.width + 1);
        for (const button of await menu.locator("button:enabled:visible").all()) {
          await button.scrollIntoViewIfNeeded();
          assert(
            await button.evaluate((e) => {
              const r = e.getBoundingClientRect();
              return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
            "Menu option must receive touches",
          );
        }
        menus.push({ selector, state, geometry });
        await page.screenshot({ path: `${out}/${selector.slice(1)}-${state}-${locale}-${width}.png` });
      };
      await page.locator("#modeButton").click();
      await check("#permissionMenu", "normal");
      await page.locator('[data-permission-mode="full-access"]').click();
      await page.locator("#fullAccessDialog[open]").waitFor();
      assert.equal(
        await page.locator("#modeButton").getAttribute("data-permission-mode"),
        "default",
        "Opening confirmation cannot grant full access",
      );
      await page.locator('#fullAccessDialog [value="cancel"]').click();
      if (await page.locator("#pendingApprovalNotice").isVisible()) {
        await page.locator("#pendingApprovalNotice").click();
        await page.locator("#approvalInboxDialog .approval-deny").first().click();
        await page.locator("#approvalInboxDialog").waitFor({ state: "hidden" });
      }
      await page.locator("#modeButton").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#permissionMenu").isVisible(), false);
      assert.equal(await page.locator("#modeButton").evaluate((e) => e === document.activeElement), true);
      await page.locator("#modelButton").click();
      await check("#modelMenu", "main");
      await page.locator("#modelSubmenuButton").click();
      await check("#modelMenu", "models");
      await page.locator("#modelMenuBack").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#modelButton").evaluate((e) => e === document.activeElement), true);
      await page.evaluate(() =>
        globalThis.__pandaForceDebug.setPermissionProfiles([
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `team-${i}`,
            description: "A managed workspace permission profile with a longer explanation.",
            allowed: true,
          })),
          { id: "blocked", description: "Unavailable policy", allowed: false },
        ]),
      );
      await page.locator("#modeButton").click();
      await check("#permissionMenu", "profiles");
      assert(await page.locator('[data-permission-mode="profile:blocked"]').isDisabled());
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width, height: Math.min(height, 420) });
      await page.locator("#modeButton").click();
      await check("#permissionMenu", "short");
      const close = page.locator("#permissionMenu .session-menu-close");
      if (await close.isVisible()) await close.click();
      else await page.keyboard.press("Escape");
      assert.equal(
        await page.locator("#permissionMenu").evaluate((e) => e.closest("#permissionPicker") !== null),
        true,
      );
      await page.locator("#modelButton").click();
      await page.locator(".window-brand strong").click();
      assert.equal(await page.locator("#modelMenu").isVisible(), false);
      assert.deepEqual(errors, []);
      results.push({ width, height, locale, menus, confirmationPreserved: true, keyboardRecovery: true });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, contexts: results.length }));
} finally {
  await app.dispose();
}
