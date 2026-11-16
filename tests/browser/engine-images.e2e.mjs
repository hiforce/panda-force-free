import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/engine-images";
await mkdir(out, { recursive: true });
const original = await sharp(new URL("../../public/assets/panda-icon.png", import.meta.url).pathname)
  .resize(900, 600, { fit: "contain", background: "#0d2034" })
  .png()
  .toBuffer();
const path = "/tmp/engine-only-viewed-image.png";
const app = await createAppFixture({ engineFiles: { [path]: original.toString("base64") } });
const records = [];
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 950 }, locale: "zh-CN" });
      await app.signIn(context);
      await context.addInitScript(() => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/task/old-alpha");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const image = page.locator('.activity-image-grid img[src^="/api/images/engine?"]').first();
      await image.waitFor();
      await image.evaluate((image) => image.scrollIntoView());
      try {
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".activity-image-grid img")].some((image) => image.naturalWidth === 640),
        );
      } catch (error) {
        await writeFile(
          `${out}/failure-${width}.json`,
          JSON.stringify(
            {
              images: await page
                .locator(".activity-image-grid img")
                .evaluateAll((images) =>
                  images.map((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth })),
                ),
              calls: app
                .calls()
                .filter((call) => call.method?.startsWith("fs/"))
                .map((call) => ({ method: call.method, params: call.params })),
            },
            null,
            2,
          ),
        );
        throw error;
      }
      const source = await image.getAttribute("src");
      assert(source.includes("thumbnail=1"));
      const response = await context.request.get(app.base + source.replace("&thumbnail=1", ""));
      assert.equal(response.status(), 200);
      assert.deepEqual(await response.body(), original);
      assert.equal((await context.request.get(app.base + "/api/images/engine?token=forged")).status(), 404);
      const unauth = await fetch(app.base + source);
      assert.equal(unauth.status, 401);
      await image.click();
      await page.locator("#imageViewer[open]").waitFor();
      await page.waitForFunction(() => document.querySelector("#imageViewerImage").naturalWidth === 900);
      await page.screenshot({ path: `${out}/viewer-${width}.png` });
      await page.keyboard.press("Escape");
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".activity-image-grid img")].some((image) => image.naturalWidth === 640),
      );
      await page.screenshot({ path: `${out}/history-${width}.png` });
      assert.deepEqual(errors, []);
      records.push({
        width,
        enginePrivateImageVisible: true,
        originalBytesMatched: true,
        fullScreenAndReload: true,
        authenticationAndTokenChecked: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.stop();
}
