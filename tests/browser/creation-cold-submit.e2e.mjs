import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-cold-submit";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  startupTimeoutMs: 60000,
  models: [
    {
      id: "fixture",
      model: "fixture",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
});
const endpoint = "/api/personal/document-creations";
const imageBrief = "请画一张三格漫画，介绍太阳系的行星。";
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
        locale,
      });
      await app.signIn(context);
      const page = await context.newPage();
      const catalog = Promise.withResolvers(),
        discovery = Promise.withResolvers(),
        acknowledgement = Promise.withResolvers();
      const post = Promise.withResolvers(),
        destination = Promise.withResolvers();
      let posts = 0,
        destinationReads = 0;
      await page.route("**/api/model-catalog?scope=creation", async (route) => {
        await catalog.promise;
        await route.continue();
      });
      await page.route("**/api/model-catalog?runtimeId=*", async (route) => {
        await discovery.promise;
        await route.continue();
      });
      await page.route("**" + endpoint + "/options", (route) => {
        destinationReads++;
        destination.resolve();
        return route.continue();
      });
      await page.route("**" + endpoint, async (route) => {
        if (route.request().method() !== "POST" || ++posts > 1) return route.continue();
        post.resolve(route.request().postDataJSON());
        await acknowledgement.promise;
        const queued = await route.fetch();
        await route.abort("failed");
        assert.equal(queued.status(), 202, await queued.text());
      });
      await page.goto(app.base + "/create");
      await destination.promise;
      await page.locator("#prompt").fill(imageBrief);
      await page.locator("#composerSettingsButton").click();
      assert.equal(await page.locator('[data-composer-setting="permissions"]').count(), 0);
      assert(await page.locator('[data-composer-setting="model"]').isVisible());
      await page.screenshot({ path: `${out}/settings-${width}.png` });
      await page.keyboard.press("Escape");
      const sendSize = await page.locator("#sendButton").evaluate((node) => [node.offsetWidth, node.offsetHeight]);
      await page.locator("#sendButton").click();
      const status = page.locator('.creation-session-notice[data-phase="sending"]');
      await status.waitFor({ state: "attached" });
      assert.match(await status.textContent(), /Submitting|提交中/);
      assert(await status.evaluate((node) => node.classList.contains("sr-only")));
      assert(await page.locator("#sendButton").isDisabled());
      assert.equal(await page.locator("#sendButton").getAttribute("aria-busy"), "true");
      const indicator = page.locator("#sendButton .busy-indicator");
      assert(await indicator.isVisible());
      assert.equal(await indicator.evaluate((node) => getComputedStyle(node).animationName), "busy-indicator-rotate");
      assert.deepEqual(
        await page.locator("#sendButton").evaluate((node) => [node.offsetWidth, node.offsetHeight]),
        sendSize,
      );
      await page.screenshot({ path: `${out}/sending-${width}.png` });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await indicator.evaluate((node) => getComputedStyle(node).animationName), "none");
      catalog.resolve();
      const request = await post.promise;
      assert.equal(request.runtimeId, "codex");
      assert.equal(request.outputType, "auto");
      assert.equal(destinationReads, 1);
      assert.equal(await page.locator(".creation-session-notice button").count(), 0);
      const oldRequest = await context.request.post(app.base + endpoint, {
        headers: { Origin: app.base },
        data: { ...request, id: crypto.randomUUID(), runtimeId: "" },
      });
      assert.equal(oldRequest.status(), 400);
      assert.equal((await oldRequest.json()).code, "invalidInput");
      acknowledgement.resolve();
      const retry = page.locator('.creation-session-notice[data-phase="pending"] button');
      await retry.waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), imageBrief);
      const accepted = page.waitForResponse(
        (response) => response.url().endsWith(endpoint) && response.request().method() === "POST",
      );
      await retry.click();
      const response = await accepted;
      assert.equal(response.status(), 202, await response.text());
      assert.deepEqual(response.request().postDataJSON(), request);
      assert.equal(posts, 2);
      discovery.resolve();
      await page.waitForURL("**/creation/" + request.id + "?creationScope=personal");
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
