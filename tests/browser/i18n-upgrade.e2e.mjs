import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

const fixture = await createBrowserFixture();
const browser = await (process.env.PANDA_FORCE_TEST_BROWSER === "webkit" ? webkit : chromium).launch();
const english = JSON.parse(await readFile("public/locales/en.json", "utf8"));
const chinese = JSON.parse(await readFile("public/locales/zh-CN.json", "utf8"));
delete english.shell;
delete chinese.shell;
await mkdir(".artifacts/i18n-upgrade", { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "zh-CN" });
    await fixture.signIn(context);
    const errors = [],
      unversioned = [];
    // Reproduce a login bundle from before the shell namespace was introduced.
    await context.route("**/auth-bootstrap.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `import {createI18n} from '/i18n.js?legacy-seed';
        const legacy = createI18n({resources:{en:${JSON.stringify(english)}},loaders:{'zh-CN':async()=>(${JSON.stringify(chinese)})}});
        await legacy.ready;
        window.legacyLocaleOwner = legacy;
        window[Symbol.for('PandaForce.browserI18n')] = legacy;
        await import('/auth-bootstrap.js?current');`,
      }),
    );
    await context.route("**/i18n.js", (route) => {
      unversioned.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.base + "/workspace");
    await page.locator(".workbench-mobile-nav").waitFor({ state: width < 768 ? "visible" : "attached" });
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    assert.deepEqual(
      await page.evaluate(() => ({
        replaced: window.legacyLocaleOwner !== window.__pandaForceI18n,
        hasShell: window.__pandaForceI18n.has("shell.preferences"),
        locale: window.__pandaForceI18n.locale,
      })),
      { replaced: true, hasShell: true, locale: "zh-CN" },
    );
    const open = async (menu) => {
      if (width < 768) {
        await page.locator('[data-chrome-menu="preferences"]').click();
        assert.equal(await page.locator("#workbenchPreferencesTitle").innerText(), "工作台偏好");
        assert.doesNotMatch(await page.locator("#workbenchPreferences").innerText(), /shell\./);
        await page.locator(`[data-chrome-action="menu"][data-value="${menu}"]`).click();
      } else await page.locator(`[data-chrome-menu="${menu}"]`).click();
    };
    for (const [menu, title] of [
      ["language", "语言"],
      ["appearance", "外观"],
      ["layout", "布局"],
    ]) {
      await open(menu);
      assert.equal(await page.locator("#workbenchPreferencesTitle").innerText(), title);
      assert.doesNotMatch(await page.locator("#workbenchPreferences").innerText(), /shell\./);
      if (menu === "language") await page.screenshot({ path: `.artifacts/i18n-upgrade/fixed-${width}.png` });
      await page.locator(".chrome-menu-close").click();
    }
    // Compatible consumers must share the existing binding owner across module URLs.
    await page.evaluate(async () => {
      const facade = await import("/i18n.js?compatible-consumer");
      const label = document.createElement("span");
      label.id = "adopted-locale-binding";
      facade.localizeText(label, "shell.preferences");
      document.body.append(label);
    });
    await open("language");
    await page.locator('[data-chrome-action="locale"][data-value="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(await page.locator("#adopted-locale-binding").innerText(), "Workspace preferences");
    await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
    assert.equal(
      await page.locator("#workbenchPreferencesTitle").innerText(),
      width < 768 ? "Workspace preferences" : "Language",
    );
    assert.doesNotMatch(await page.locator("#workbenchPreferences").innerText(), /shell\./);
    assert.deepEqual(unversioned, []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Desktop and mobile upgrades replace incompatible locale owners, avoid unversioned imports and translate all preference menus.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
