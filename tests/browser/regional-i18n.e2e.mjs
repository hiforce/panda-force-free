import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/regional-chinese/screens",
  records = [];
await mkdir(out, { recursive: true });
const english = JSON.parse(await readFile("public/locales/en.json", "utf8"));
for (const [engine, width, browserLocale, initial] of [
  [chromium, 1440, "zh-Hant-HK", "zh-HK"],
  [webkit, 390, "zh-Hant-TW", "zh-TW"],
  [webkit, 320, "zh-HK", "zh-HK"],
]) {
  const app = await createAppFixture({
      applicationCreation: true,
      models: [
        {
          id: "gpt-fixture",
          model: "gpt-fixture",
          isDefault: true,
          displayName: "Fixture model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ],
    }),
    browser = await engine.launch();
  let debugPage;
  try {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: browserLocale }),
      errors = [];
    await context.addInitScript(
      (theme) => {
        if (window === window.top && /^https?:$/.test(location.protocol))
          localStorage.setItem("panda-force-theme", theme);
      },
      width > 700 ? "silk" : "aurora",
    );
    await app.signIn(context);
    // An earlier login bundle has all current messages but only the former two-language registry.
    const staleBootstrap = (url) => url.pathname === "/auth-bootstrap.js" && !url.searchParams.has("current");
    await context.route(staleBootstrap, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `import {createI18n} from '/i18n.js?two-language-owner';
   const legacy=createI18n({registry:[{code:'en',name:'English',direction:'ltr'},{code:'zh-CN',name:'简体中文',direction:'ltr'}],resources:{en:${JSON.stringify(english)}},loaders:{}});
   await legacy.ready;window.regionalLegacyOwner=legacy;window[Symbol.for('PandaForce.browserI18n')]=legacy;await import('/auth-bootstrap.js?current');`,
      }),
    );
    const page = await context.newPage();
    debugPage = page;
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.base + "/task/old-alpha");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.waitForFunction((locale) => document.documentElement.lang === locale, initial);
    assert.equal(await page.evaluate(() => window.regionalLegacyOwner !== window.__pandaForceI18n), true);
    await context.unroute(staleBootstrap);
    const openLanguage = async () => {
      await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
      if (width < 768) await page.locator('[data-chrome-action="menu"][data-value="language"]').click();
      await page.locator("#workbenchPreferences[open]").waitFor();
    };
    const choose = async (locale) => {
      await openLanguage();
      await page.locator(`[data-chrome-action="locale"][data-value="${locale}"]`).click();
      await page.waitForFunction((value) => document.documentElement.lang === value, locale);
      await page.locator("#workbenchPreferences").waitFor({ state: "hidden" });
    };
    const navigate = async (route) => {
      const mobile = page.locator(`.workbench-mobile-nav [data-route="${route}"]`);
      if (width < 768 && (await mobile.isVisible())) await mobile.click();
      else {
        if (width < 768) {
          await page.locator("#workspaceNavigationToggle").click();
          await page.locator("#sidebar.mobile-open").waitFor({ state: "visible" });
        }
        await page.locator(`#sidebar [data-route="${route}"]`).click();
      }
      await page.waitForURL("**/" + route);
    };
    await page.locator("#prompt").fill("Keep Settings 软件 exactly as entered.");
    await page.evaluate(() => {
      window.regionalPrompt = document.getElementById("prompt");
      const probe = document.createElement("p");
      probe.id = "regionalOpaque";
      probe.textContent = "用户内容：软件、项目、Settings";
      probe.dataset.i18nIgnore = "";
      document.body.append(probe);
    });
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      await choose(locale);
      assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-locale")), locale);
      assert.equal(await page.locator("#prompt").inputValue(), "Keep Settings 软件 exactly as entered.");
      assert.equal(await page.evaluate(() => window.regionalPrompt === document.getElementById("prompt")), true);
      assert.equal(await page.locator("#regionalOpaque").innerText(), "用户内容：软件、项目、Settings");
      const projectLabel = await page
        .locator(width < 768 ? '.workbench-mobile-nav [data-route="projects"]' : '#sidebar [data-route="projects"]')
        .textContent();
      assert.match(
        projectLabel,
        locale === "en" ? /Projects/ : locale === "zh-CN" ? /项目/ : locale === "zh-HK" ? /項目/ : /專案/,
      );
    }
    await navigate("skills");
    const gallerySearch = page.locator("[data-template-search]");
    await gallerySearch.fill("PRD");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".template-card").length === 1 &&
        document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
    );
    await gallerySearch.focus();
    await page.evaluate(() => {
      window.regionalGallerySearch = document.querySelector("[data-template-search]");
      window.regionalGalleryCard = document.querySelector(".template-card");
    });
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), locale);
      const title =
        locale === "en"
          ? "Software PRD"
          : locale === "zh-CN"
            ? "软件需求 PRD"
            : locale === "zh-HK"
              ? "軟件需求 PRD"
              : "軟體需求 PRD";
      await page.locator(".template-card-shell").filter({ hasText: title }).waitFor();
      assert.equal(await gallerySearch.inputValue(), "PRD");
      assert.equal(
        await page.evaluate(
          () =>
            window.regionalGallerySearch === document.querySelector("[data-template-search]") &&
            window.regionalGalleryCard === document.querySelector(".template-card") &&
            document.activeElement === window.regionalGallerySearch,
        ),
        true,
      );
      const messages = JSON.parse(await readFile(`public/locales/${locale}.json`, "utf8"));
      assert.equal(
        await page.locator('[data-template-action="import"] .template-import-label').innerText(),
        messages.templates.import,
      );
      assert.equal(
        await page.locator('[data-template-type] option[value=""]').innerText(),
        messages.templates.allTypes,
      );
    }
    await gallerySearch.fill("");
    for (const locale of ["zh-HK", "zh-TW"]) {
      await choose(locale);
      await navigate("skills");
      const title = locale === "zh-HK" ? "軟件需求 PRD" : "軟體需求 PRD";
      await page.locator(".template-card-shell").filter({ hasText: title }).first().waitFor();
      assert.match(
        await page.locator('[data-skills-select] option[value="slides"]').innerText(),
        locale === "zh-HK" ? /投影片/ : /簡報/,
      );
      await page.screenshot({ path: `${out}/skills-${locale}-${width}.png`, scale: "css" });
      await page.locator('.skills-gallery-tools [data-skills-action="categories"]').click();
      const categories = page.locator("#skillWorkspaceDialog[open]");
      await categories.locator('[data-skills-action="new-category"]').click();
      assert.equal(await categories.locator("[data-skill-category-locale]").count(), 4);
      await categories.locator('input[name="en"]').fill("Picks " + locale);
      await categories.locator('input[name="zh"]').fill("我的精选 " + locale);
      await categories.locator('input[name="zh-HK"]').fill("香港常用 " + locale);
      await categories.locator('input[name="zh-TW"]').fill("台灣常用 " + locale);
      await page.screenshot({ path: `${out}/category-${locale}-${width}.png`, scale: "css" });
      await categories.locator('[data-skills-action="save-category"]').click();
      await categories.locator(".skills-category-list").waitFor();
      await categories.locator('header [data-skills-action="close"]').click();
    }
    await choose(initial);
    await openLanguage();
    assert.equal(await page.locator('[data-chrome-action="locale"]').count(), 5);
    await page.screenshot({ path: `${out}/languages-${initial}-${width}.png`, scale: "css" });
    await page.locator(".chrome-menu-close").click();
    await navigate("create");
    await page.locator("#gadgetDocumentPrompt").fill("Write an English PRD. Preserve 软件 and Settings in my brief.");
    const creation = page.locator(".gadget-document-form");
    await creation.locator("[data-gd-skills]").click();
    const picker = page.locator(".creation-skill-browser[open]");
    await picker.locator(".creation-skill-option").first().waitFor();
    const expected = initial === "zh-HK" ? "軟件需求 PRD" : "軟體需求 PRD";
    const prd = picker.locator(".creation-skill-option").filter({ hasText: expected });
    await prd.locator(".creation-skill-choose").click();
    await prd.locator('[data-skill-action="details"]').click();
    const detail = page.locator(".creation-skill-detail[open]");
    await detail.waitFor();
    assert.match(await detail.innerText(), /可編輯文件/);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${out}/picker-${initial}-${width}.png`, scale: "css" });
    await picker.locator("footer [data-skill-browser-close]").click();
    assert.equal(await creation.locator('[data-selected-skill="software-prd"]').count(), 1);
    await creation.locator("[data-gd-skills]").click();
    assert.equal(await prd.locator(".creation-skill-choose").getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.waitForFunction((locale) => document.documentElement.lang === locale, initial);
    assert.equal(await page.evaluate(() => window.__pandaForceI18n.preference), initial);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    records.push({
      engine: engine.name(),
      width,
      initial,
      localeChoices: 4,
      allCurrentMessagesLegacyOwnerReplaced: true,
      opaqueDraftPreserved: true,
      regionalCatalogAndMetadata: true,
      categoryFields: 4,
      preferenceSurvivedReload: true,
    });
    await context.close();
    if (width === 1440) {
      const recovery = await browser.newContext({ viewport: { width, height: 1000 }, locale: "en" });
      await app.signIn(recovery);
      let fail = true;
      await recovery.route("**/locales/zh-TW.json?*", (route) => (fail ? route.abort() : route.continue()));
      const recoverPage = await recovery.newPage();
      debugPage = recoverPage;
      await recoverPage.goto(app.base + "/workspace");
      await recoverPage.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await recoverPage.locator('[data-chrome-menu="language"]').click();
      await recoverPage.locator('[data-chrome-action="locale"][data-value="zh-TW"]').click();
      await recoverPage.waitForFunction(() => window.__pandaForceI18n.preference === "zh-TW");
      assert.equal(await recoverPage.locator("html").getAttribute("lang"), "en");
      await recoverPage.locator('[data-chrome-menu="language"]').click();
      await recoverPage.getByText("This language pack could not be loaded.", { exact: false }).waitFor();
      fail = false;
      await recoverPage.locator('[data-chrome-action="locale"][data-value="zh-TW"]').click();
      await recoverPage.waitForFunction(() => document.documentElement.lang === "zh-TW");
      assert.equal(await recoverPage.evaluate(() => window.__pandaForceI18n.preference), "zh-TW");
      await recovery.close();
    }
  } catch (error) {
    if (debugPage) {
      await debugPage.screenshot({ path: `${out}/failure-${width}.png` });
      console.error(await debugPage.locator("dialog[open]").allTextContents());
    }
    throw error;
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(
  ".artifacts/regional-chinese/browser-verified.json",
  JSON.stringify({ passed: true, records }, null, 2),
);
console.log(
  "Regional preferences, complete metadata, immutable data, legacy owner replacement and language-pack retry verified on PC/H5.",
);
