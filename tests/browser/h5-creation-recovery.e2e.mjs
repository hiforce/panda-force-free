import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/h5-creation-recovery";
await mkdir(out, { recursive: true });
const records = [];
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture({
      applicationCreation: true,
      models: [
        {
          id: "fixture",
          model: "fixture",
          isDefault: true,
          displayName: "Fixture",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
        },
      ],
    }),
    browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale,
      hasTouch: width < 768,
      isMobile: width < 768,
    });
    await app.signIn(context);
    const headers = { Origin: app.base };
    await context.request.post(app.base + "/api/system/database/selection", { headers, data: { driver: "sqlite" } });
    const options = await (await context.request.get(app.base + "/api/personal/document-creations/options")).json();
    const id = crypto.randomUUID();
    assert.equal(
      (
        await context.request.post(app.base + "/api/personal/document-creations", {
          headers,
          data: {
            id,
            projectId: "personal",
            treeVersion: 0,
            parentId: null,
            locale,
            prompt: "编写商品资料协作平台需求说明",
            profileId: options.defaultProfileId,
            selections: [options.defaultWorkflow],
          },
        })
      ).status(),
      202,
    );
    const layout = await (await context.request.get(app.base + "/api/gadgets/layout")).json();
    layout.items = layout.items.filter((i) => i.gadget !== "system.creations");
    layout.mobileOrder = layout.mobileOrder.filter((i) => i !== "system.creations");
    assert(
      (
        await context.request.put(app.base + "/api/gadgets/layout", {
          headers: { ...headers, "If-Match": `"${layout.revision}"` },
          data: { operationId: crypto.randomUUID(), layout },
        })
      ).ok(),
    );
    await context.addInitScript(
      ({ locale }) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      },
      { locale },
    );
    const page = await context.newPage(),
      errors = [],
      seen = [];
    let imports = 0,
      blocked = true;
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => seen.push(r.url()));
    await page.route("**/gadget-document.bundle.js*", (route) => (blocked ? route.abort("failed") : route.continue()));
    await page.route("**/content-workspace.bundle.js*", (route) => route.abort("failed"));
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
    await page.locator("#gadgetDocumentPrompt").fill("网络恢复时保留我的输入");
    if (["en", "zh-CN"].includes(locale)) {
      await page.evaluate(() => {
        const form = document.querySelector(".gadget-document-form");
        form.requestSubmit();
        form.requestSubmit();
      });
      await page.waitForFunction(() => document.body.dataset.workbenchPage === "task");
      for (
        let attempt = 0;
        attempt < 100 &&
        !app
          .calls()
          .some(
            (call) =>
              call.method === "turn/start" && JSON.stringify(call.params?.input).includes("网络恢复时保留我的输入"),
          );
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const sent = app
        .calls()
        .filter(
          (call) =>
            call.method === "turn/start" && JSON.stringify(call.params?.input).includes("网络恢复时保留我的输入"),
        );
      assert.equal(sent.length, 1, "The visible input sends a native task once while tools are offline");
      await page.goto(app.base + "/workspace");
      await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
      await page.locator("#gadgetDocumentPrompt").fill("网络恢复时保留我的输入");
    }

    await page.locator(".gadget-workspace-heading a[href='/create?view=activity']").click();
    await page.locator(`[data-activity-task="${id}"]`).waitFor();
    assert(
      !seen.some((u) => u.includes("content-workspace.bundle.js")),
      "Creation records must not require the asset-library module",
    );
    assert.equal(await page.locator("#composer").isVisible(), false);
    await page.screenshot({ path: `${out}/history-with-tools-blocked-${width}-${locale}.png`, fullPage: true });
    const openDetail = page.waitForRequest((request) => request.url().includes("/document-creations/detail?"));
    await page.locator(`[data-activity-task="${id}"]`).click();
    await page.locator("#conversation .user-message").first().waitFor();
    await openDetail;
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
    await page.locator("[data-gd-retry]:visible").waitFor();
    blocked = false;
    await page.unroute("**/gadget-document.bundle.js*");
    await page.route("**/gadget-document.bundle.js*", (route) => {
      if (route.request().resourceType() === "script" && imports++ < 2) return route.abort("failed");
      return route.continue();
    });
    const field = page.locator("#gadgetDocumentPrompt");
    await field.focus();
    await field.evaluate((n) => n.setSelectionRange(2, 5));
    await page.locator("[data-gd-retry]").click();
    await page.waitForFunction(() => document.querySelector("[data-gd-retry]")?.hidden === false);
    for (let attempt = 0; attempt < 3 && (await page.locator("[data-gd-skills]").isDisabled()); attempt++) {
      await page.locator("[data-gd-retry]:visible").waitFor();
      await page.locator("[data-gd-retry]").click();
      await page.waitForFunction(
        () =>
          !document.querySelector("[data-gd-skills]")?.disabled ||
          document.querySelector("[data-gd-retry]")?.hidden === false,
      );
    }
    await page.locator("[data-gd-skills]:enabled").waitFor();
    assert.equal(await field.inputValue(), "网络恢复时保留我的输入");
    assert(imports >= 3);
    await page.screenshot({ path: `${out}/recovered-${width}-${locale}.png`, fullPage: true });
    await page.locator("[data-gd-skills]").click();
    await page.locator('.creation-skill-browser[open] [data-skill-id="software-prd"]:enabled').waitFor();
    await page.locator('.creation-skill-browser[open] [data-skill-id="software-prd"]').click();
    await page.locator(".creation-skill-browser[open] footer [data-skill-browser-close]").click();
    blocked = true;
    await page.unroute("**/gadget-document.bundle.js*");
    await page.route("**/gadget-document.bundle.js*", (route) => route.abort("failed"));
    await page.reload();
    await page.locator("#gadgetDocumentPrompt").waitFor();
    assert.equal(await field.inputValue(), "网络恢复时保留我的输入");
    assert(
      await page.locator("[data-gd-start]").isDisabled(),
      "An existing selected skill must not be silently submitted as a plain task",
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.deepEqual(errors, []);
    records.push({
      engine: engine.name(),
      width,
      locale,
      historyWithoutWidgetAndLazyTools: true,
      conversationOnDemand: true,
      repeatedImportFailuresRecover: true,
      draftPreserved: true,
      selectedSkillNotBypassed: true,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
