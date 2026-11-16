import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { renderTemplatePreview } from "../../src/preview-renderer/render.js";

const executor = await createSampleExecutorHttp(),
  token = randomBytes(32).toString("hex");
let captures = 0,
  fail = true;
const renderer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer " + token) return new Response(null, { status: 401 });
    if (fail) return new Response(null, { status: 503 });
    captures++;
    return Response.json(await renderTemplatePreview(await request.json()));
  },
});
const advance = setInterval(() => {
  for (const id of [...executor.gates.keys()]) executor.release(id);
}, 50);
const app = await createAppFixture({
  extraEnvironment({ dir }) {
    const buildToken = join(dir, "build-token"),
      previewToken = join(dir, "preview-token");
    writeFileSync(buildToken, executor.token, { mode: 0o600 });
    writeFileSync(previewToken, token, { mode: 0o600 });
    return {
      PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url,
      PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: buildToken,
      PANDA_FORCE_PREVIEW_RENDERER_URL: `http://127.0.0.1:${renderer.port}`,
      PANDA_FORCE_PREVIEW_TOKEN_FILE: previewToken,
    };
  },
});
const evidence = ".artifacts/template-screenshot-product";
await mkdir(evidence, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 500 ? "dark" : "light",
      });
      await app.signIn(context);
      page = await context.newPage();
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/publish/website");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-publish-format="all"]').click();
      const card = page.locator('[data-template-key^="builtin:site-theme:panda.reader:"]');
      await card.locator(".template-cover img").waitFor();
      assert.ok(await card.locator("img").evaluate((node) => node.complete && node.naturalWidth === 1440));
      await card.click();
      const detail = page.locator("#managedTemplateDialog");
      await detail.locator('[data-template-detail="preview"]:enabled').click();
      const panel = detail.locator(".template-screenshots");
      await panel.locator("[data-preview-image] img").waitFor();
      await panel.locator('[data-preview-view="article"]').click();
      assert.match(await panel.locator("img").getAttribute("src"), /article/);
      await panel.locator("[data-preview-generate]:enabled").click();
      if (fail) {
        await waitFor(async () => /could not|生成失败/.test(await panel.locator("[data-preview-status]").innerText()));
        fail = false;
        await panel.locator("[data-preview-generate]:enabled").click();
      }
      await waitFor(async () =>
        /Screenshots ready|预览已就绪/.test(await panel.locator("[data-preview-status]").innerText()),
      );
      await panel.locator('[data-preview-view="mobile"]').click();
      await waitFor(async () => panel.locator("img").evaluate((node) => node.complete && node.naturalWidth === 390));
      const captured = captures;
      assert.ok(captured > 0);
      await page.screenshot({ path: `${evidence}/mobile-tab-${width}.png` });
      await detail.locator('[data-template-detail="close"]').click();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await card.click();
      await detail.locator('[data-template-detail="preview"]:enabled').click();
      await waitFor(async () =>
        panel
          .locator("[data-preview-image] img")
          .evaluate(
            (node) => node.complete && node.naturalWidth === 1440 && node.src.includes("/api/template-previews/image"),
          ),
      );
      assert.equal(captures, captured);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${evidence}/cached-${width}.png` });
      console.log(
        `${engine.name()} ${width}: actual gallery covers, real renderer home/article/mobile, actionable failure/retry and persisted private cache passed`,
      );
      await context.close();
    } catch (error) {
      if (page) await page.screenshot({ path: `${evidence}/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
  clearInterval(advance);
  await executor.stop();
  await renderer.stop(true);
}
