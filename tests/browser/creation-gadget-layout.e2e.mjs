import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-gadget-layout";
await mkdir(out, { recursive: true });
const records = [];
for (const [engine, width, locale] of [
  [chromium, 1440, "zh-CN"],
  [webkit, 390, "zh-TW"],
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
    const context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
    await app.signIn(context);
    await context.addInitScript(() => {
      if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
    });
    const post = async (path, data) => {
      const response = await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
      assert(response.ok(), await response.text());
      return response.json();
    };
    await post("/api/system/database/selection", { driver: "sqlite" });
    const options = await (await context.request.get(app.base + "/api/personal/document-creations/options")).json();
    const request = {
      id: randomUUID(),
      projectId: "personal",
      treeVersion: 0,
      parentId: null,
      locale,
      prompt: "编写商品资料协作平台的需求说明，包含资料维护、内容审核和发布审批。",
      profileId: options.defaultProfileId,
      selections: [options.defaultWorkflow],
    };
    await post("/api/personal/document-creations", request);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.goto(app.base + "/workspace");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator("[data-gw=customize]:enabled").waitFor();
    const creation = page.locator('[data-gadget-type-id="system.creations"]'),
      composer = page.locator('[data-gadget-type-id="system.composer"]');
    await creation.locator(`[data-activity-task="${request.id}"]`).waitFor();
    const before = await creation.boundingBox(),
      input = await composer.boundingBox();
    assert.equal(await page.locator("#workbenchCreationActivity").count(), 0);
    if (width >= 1050) {
      assert(before.x >= input.x + input.width);
      assert(Math.abs(before.y - input.y) < 2);
    } else assert(before.y >= input.y + input.height);
    await page.screenshot({ path: `${out}/default-${width}.png`, fullPage: true });
    await creation.locator(`[data-activity-task="${request.id}"]`).click();
    await page.locator('.creation-detail-page [data-detail-tab="conversation"]').waitFor();
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator('[data-detail-tab="conversation"]').click();
    await page.locator('[data-conversation-role="user"]').waitFor();
    assert.match(await page.locator("[data-detail-conversation]").innerText(), /商品资料协作平台/);
    await page.locator("[data-detail-back]").click();
    await page.locator("#gadgetDocumentPrompt").fill("保留当前输入，调整创作记录组件的位置。");
    await page.locator("[data-gw=customize]").click();
    if (width >= 1050) {
      await creation
        .locator("[data-gadget-handle]")
        .dragTo(page.locator(".gadget-canvas"), { targetPosition: { x: 20, y: 450 } });
      await creation.locator("[data-gadget-handle]").press("Shift+ArrowDown");
    } else await creation.locator('[data-gw="down"]').click();
    await page.locator("[data-gw=save]").click();
    await page.locator("[data-gw=customize]:enabled").waitFor();
    const saved = await (await context.request.get(app.base + "/api/gadgets/layout")).json(),
      instance = saved.items.find((item) => item.gadget === "system.creations");
    assert(instance);
    if (width >= 1050) {
      assert.equal(instance.x, 0);
      assert(instance.y > 0);
      assert.equal(instance.h, 12);
    } else assert(saved.mobileOrder.indexOf(instance.id) > 1);
    await page.reload();
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator("[data-gw=customize]:enabled").waitFor();
    assert.equal(await page.locator("#gadgetDocumentPrompt").inputValue(), "保留当前输入，调整创作记录组件的位置。");
    const restored = await (await context.request.get(app.base + "/api/gadgets/layout")).json();
    assert.deepEqual(restored, saved);
    assert.equal(await page.locator(".creation-detail-page").count(), 0);
    if (width >= 1050) {
      await page.locator("[data-gw=customize]").click();
      await creation.locator('[data-gw="remove"]').click();
      await page.locator("[data-gw=save]").click();
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("[data-gw=customize]:enabled").waitFor();
      assert.equal(await page.locator('[data-gadget-type-id="system.creations"]').count(), 0);
      assert.equal(await page.locator(".creation-detail-page").count(), 0);
    }
    await page.goto(app.base + "/create?" + new URLSearchParams({ creation: request.id, creationScope: "personal" }));
    await page.locator('.creation-detail-page [data-detail-tab="conversation"]').waitFor();
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator("[data-detail-back]").click();
    const pair = page.locator(".creation-entry"),
      left = await pair.locator("[data-creation-entry-composer]").boundingBox(),
      right = await pair.locator("[data-creation-entry-activity]").boundingBox();
    if (width >= 1050) assert(right.x >= left.x + left.width);
    else assert(right.y >= left.y + left.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${out}/create-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    records.push({
      width,
      locale,
      registered: true,
      defaultPosition: width >= 1050 ? "beside-composer" : "after-composer",
      pointerDragOrMobileOrder: true,
      resizeOrOrderSaved: true,
      reloadPreservesLayoutAndInput: true,
      detailAndDeepLink: true,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.stop();
  }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
