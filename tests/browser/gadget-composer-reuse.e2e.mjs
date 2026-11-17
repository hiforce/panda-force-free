import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-composer-reuse";
await mkdir(out, { recursive: true });
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
});
const project = app.legacyProject({ name: "eshop-sample", code: "eshop-sample" }).projects[0],
  records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        hasTouch: width < 768,
        isMobile: width < 768,
      });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      await context.addInitScript((locale) => {
        if (window === top && /^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      let optionsReads = 0,
        submissions = 0;
      page.on("request", (request) => {
        if (request.url().includes("/document-creations/options")) optionsReads++;
        if (request.method() === "POST" && /\/document-creations$/.test(new URL(request.url()).pathname)) submissions++;
      });
      const navigate = async (route) => {
        const bottom = page.locator(`.workbench-mobile-nav [data-route="${route}"]`);
        if (await bottom.isVisible()) {
          await bottom.click();
          return;
        }
        const navigation = page.locator(`.workbench-navigation [data-route="${route}"]`);
        if (!(await navigation.isVisible())) {
          await page.locator("#workspaceNavigationToggle").click();
          await page.waitForFunction(
            () => document.querySelector("#workspaceNavigationToggle")?.getAttribute("aria-expanded") === "true",
          );
        }
        await navigation.click();
      };
      const root = page.locator('[data-gadget-type-id="system.composer"]');
      const prompt = page.locator("#gadgetDocumentPrompt");
      const chooseSkill = async () => {
        await page.locator("[data-gd-skills]").click();
        const picker = page.locator(".creation-skill-browser[open]");
        await picker.locator("[data-skill-id=software-prd]").click();
        await picker.locator("footer [data-skill-browser-close]").click();
        await page.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      };
      const shape = () =>
        root
          .locator(".gadget-document-form")
          .evaluate((form) =>
            [...form.querySelectorAll("button,textarea")]
              .map((n) => [
                n.tagName,
                n.className,
                [...n.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value]),
              ])
              .filter((value) => !value[2].some((a) => a[0] === "data-gd-suggestion")),
          );
      await page.goto(app.base + "/workspace");
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await prompt.fill("Shared personal brief");
      await prompt.evaluate((field) =>
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }),
        ),
      );
      assert.equal(new URL(page.url()).pathname, "/workspace", "Confirming an IME candidate must not send a task");
      assert.equal(submissions, 0);
      await chooseSkill();
      const fold = root.locator(".message-composer-disclosure");
      await fold.click();
      assert.equal(await fold.getAttribute("aria-expanded"), "false");
      assert((await root.locator("form").boundingBox()).height <= 54);
      assert.equal(await prompt.inputValue(), "Shared personal brief");
      await fold.click();
      assert.equal(await fold.getAttribute("aria-expanded"), "true");
      assert.equal(await root.locator("[data-selected-skill=software-prd]").count(), 1);
      await page.screenshot({ path: `${out}/workbench-${locale}-${width}.png` });
      assert.equal(await page.locator("#conversationProjectPicker").isVisible(), false);
      assert.equal(await page.locator("#businessProjectContext").isVisible(), false);
      assert.equal(await page.locator("#composer").isVisible(), false);
      const sharedShape = await shape();
      await navigate("create");
      await page.waitForURL("**/create");
      const native = page.locator("#composer");
      await native.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      assert.equal(await page.locator("#conversationProjectPicker").isVisible(), false);
      assert.equal(await page.locator(".creative-composer,#creativePrompt").count(), 0);
      assert.equal(await native.locator("#prompt").inputValue(), "Shared personal brief");
      assert.equal(await page.locator("#sessionInspector").isVisible(), false);
      const nextLocale = locale === "en" ? "zh-TW" : "en";
      await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), nextLocale);
      await page.waitForFunction((value) => document.documentElement.lang === value, nextLocale);
      await native.locator(`#sendButton[aria-label="${nextLocale === "en" ? "Send message" : "傳送訊息"}"]`).waitFor();
      assert.match(
        await native.locator('[data-selected-skill="software-prd"] strong').innerText(),
        nextLocale === "en" ? /Software PRD/ : /軟體需求/,
      );
      await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), locale);
      await page.waitForFunction((value) => document.documentElement.lang === value, locale);
      await page.screenshot({ path: `${out}/personal-${locale}-${width}.png` });
      await navigate("workspace");
      await prompt.waitFor();
      assert.equal(await prompt.inputValue(), "Shared personal brief");
      await page.locator("[data-gd-project]").click();
      await page.locator(`[data-gd-destination="${project.id}"]`).click();
      await prompt.fill("Shared project brief");
      await navigate("projects");
      await page.locator(`.project-directory-main[href="/project?id=${project.id}"]`).click();
      await page.waitForURL("**/project?id=" + project.id);
      await page.locator("[data-selected-skill=software-prd] .template-cover").waitFor();
      assert.equal(await page.locator("#conversationProjectPicker").isVisible(), false);
      assert.equal(await root.count(), 1);
      assert.equal(await prompt.inputValue(), "Shared project brief");
      assert.match(await page.locator("[data-gd-project]").innerText(), /eshop-sample/);
      assert.deepEqual(await shape(), sharedShape);
      assert.equal(submissions, 0);
      assert.equal(optionsReads, 0);
      assert.equal(await root.locator("[data-gc-mode],[data-gc-more],[data-gc-menu]").count(), 0);
      await page.screenshot({ path: `${out}/project-${locale}-${width}.png` });
      if (locale === "en") {
        await page.goto(app.base + "/task/old-alpha");
        await page.locator("#prompt").waitFor();
        await navigate("projects");
        await page.locator(`.project-directory-main[href="/project?id=${project.id}"]`).click();
        await prompt.waitFor();
        await page.waitForTimeout(100);
        assert.equal(new URL(page.url()).pathname, "/project");
        while (await root.locator('[data-skill-action="remove"]').count())
          await root.locator('[data-skill-action="remove"]').first().click();
        await prompt.fill("Start a separate task in this project");
        await page.route("**/api/creative-assets/capabilities?*", (route) => route.fulfill({ status: 503, json: {} }));
        const marker = app.calls().length;
        await root.locator("form").evaluate((form) => {
          form.requestSubmit();
          form.requestSubmit();
        });
        await page.waitForURL(/\/task\/new-/);
        const calls = app.calls().slice(marker);
        const starts = calls.filter((call) => call.method === "thread/start");
        assert.equal(starts.length, 1);
        const catalog = await (await context.request.get(app.base + "/api/projects")).json();
        assert.equal(
          catalog.assignments.find((row) => row.id === new URL(page.url()).pathname.split("/").at(-1))?.projectId,
          project.id,
        );
        assert.equal(submissions, 0);
        assert.equal(optionsReads, 0);
        assert(!calls.some((call) => call.method === "turn/start" && call.params?.threadId === "old-alpha"));
      }
      await navigate("create");
      await page.locator("#prompt").waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "Shared personal brief");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        sharedComponent: true,
        sharedDrafts: true,
        destinationMenu: true,
        singleInput: true,
        removedUnusedMenu: true,
        nativeTaskIsolation: locale === "en",
        passed: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
