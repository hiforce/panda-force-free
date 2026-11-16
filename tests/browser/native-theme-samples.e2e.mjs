import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { nativeFiles, nativeSettings, nativeZipSource } from "../support/native-theme.js";
import { unzipSync } from "fflate";

const executor = await createSampleExecutorHttp({ native: true }),
  app = await createAppFixture({
    extraEnvironment({ dir }) {
      const token = join(dir, "native-sample-token");
      writeFileSync(token, executor.token, { mode: 0o600 });
      return { PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url, PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: token };
    },
  }),
  artifactRoot = ".artifacts/native-build-jobs";
await mkdir(artifactRoot, { recursive: true });
try {
  for (const [browserType, width, locale, engine] of [
    [chromium, 1440, "en", "hexo"],
    [webkit, 390, "zh-CN", "docusaurus"],
  ]) {
    const browser = await browserType.launch({
      headless: true,
      ...(browserType === chromium ? { args: ["--no-sandbox"] } : {}),
    });
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 500 ? "dark" : "light",
      });
      await app.signIn(context);
      async function json(path, data) {
        const response =
          data instanceof Uint8Array
            ? await context.request.post(app.base + path, {
                data: Buffer.from(data),
                headers: { "content-type": "application/octet-stream" },
              })
            : data === undefined
              ? await context.request.get(app.base + path)
              : await context.request.post(app.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      }
      const id = "example.native-sample-" + width,
        { bytes } = await nativeZipSource({
          ...nativeFiles,
          "theme/index.js": "module.exports = () => ({ name: 'native-fixture' });",
        }),
        stage = await json("/api/package-sources", {
          purpose: "templates",
          operationId: randomUUID(),
          request: {
            source: {
              kind: "zip-upload",
              name: "native-sample.zip",
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        });
      await json(
        "/api/package-sources/upload?" +
          new URLSearchParams({ purpose: "templates", id: stage.id, revision: String(stage.revision) }),
        bytes,
      );
      const ready = await waitFor(async () => {
          const value = await json("/api/package-sources/task?purpose=templates&id=" + stage.id);
          if (value.state === "failed") throw Error(value.failure);
          return value.state === "ready" && value;
        }),
        input = {
          source: { id: ready.id, sha256: ready.digest, root: "theme" },
          settings: { ...nativeSettings(), id, engine, entry: engine === "hexo" ? null : "index.js" },
        },
        review = await json("/api/templates/native/review", input);
      await json("/api/templates/native/install", {
        ...input,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          permissions: ["build:theme-code"],
          licenseAcknowledged: true,
        },
      });
      page = await context.newPage();
      const errors = [],
        external = [],
        posted = [];
      let loseResponse = true,
        observed = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
      });
      page.on("response", (response) => {
        if (response.url().includes("/api/templates/native/samples/detail?")) observed++;
      });
      await page.route("**/api/templates/native/samples", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posted.push(route.request().postDataJSON().id);
        if (!loseResponse) return route.continue();
        loseResponse = false;
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 202);
        await route.abort("failed");
      });
      async function open() {
        await page.goto(app.base + "/publish/website");
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator(`[data-publish-format="${engine}"]`).click();
        await page.locator(`[data-template-key^="native:site-theme:${id}:1.0.0:"]`).click();
        const detail = page.locator("#managedTemplateDialog");
        await detail.locator('[data-template-detail="preview"]:enabled').click();
        await detail.locator(".template-static-sample > summary").click();
        return detail.locator(".site-sample-monitor");
      }
      let monitor = await open();
      await monitor.locator('[data-sample-action="start"]:enabled').click();
      await monitor.locator('[data-sample-action="start"]:enabled').waitFor();
      assert.equal(
        await monitor.locator('[data-sample-action="start"]').textContent(),
        locale === "en" ? "Retry build request" : "重试构建请求",
      );
      await monitor.locator('[data-sample-action="start"]').click();
      await monitor.locator('[data-sample-status][data-phase="running"]').waitFor();
      assert.equal(posted[0], posted[1]);
      const first = posted[0];
      await monitor.locator("details summary").click();
      const details = await monitor.locator("details").elementHandle(),
        before = observed;
      await waitFor(() => observed >= before + 2);
      assert.equal(await details.evaluate((node) => node.isConnected && node.open), true);
      monitor = await open();
      await monitor.locator('[data-sample-status][data-phase="running"]').waitFor();
      assert.equal(posted.length, 2);
      executor.release(first);
      const frame = monitor.locator('iframe[srcdoc*="#123456"]');
      await frame.waitFor();
      assert.equal(await frame.getAttribute("sandbox"), "");
      const content = await (await frame.elementHandle()).contentFrame();
      assert.equal(await content.locator("h1").evaluate((node) => getComputedStyle(node).color), "rgb(18, 52, 86)");
      assert.equal(await content.locator("script").count(), 0);
      await monitor.locator("[data-sample-preview] select").selectOption("sample/index.html");
      await monitor.locator('iframe[srcdoc*="A sample page"]').waitFor();
      assert.deepEqual(executor.resources.get(first).logo, new Uint8Array([0, 10, 255]));
      const downloaded = page.waitForEvent("download");
      await monitor.locator('[data-sample-action="download"]:enabled').click();
      const download = await downloaded;
      assert.equal(download.suggestedFilename(), `site-sample-${first}.zip`);
      const output = unzipSync(new Uint8Array(await readFile(await download.path())));
      assert.deepEqual(Object.keys(output).sort(), ["index.html", "sample/index.html", "site.css"]);
      await page.screenshot({ path: `${artifactRoot}/native-preview-${width}.png` });
      await monitor.locator('[data-sample-action="start"]:enabled').click();
      await waitFor(() => executor.gates.has(posted[2]));
      await monitor.locator('[data-sample-action="cancel"]:enabled').click();
      await monitor.locator('[data-sample-status][data-phase="cancelled"]').waitFor();
      assert.equal(executor.resources.size >= 2, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.doesNotMatch(await monitor.textContent(), /builds\.(inputBusy|storageFull|unavailable)|plugins\.sample/);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await context.close();
      console.log(
        `${browserType.name()} ${width}: native sample request retry, observation, stable logs, private multi-page preview and cancellation passed`,
      );
    } catch (error) {
      if (page && !page.isClosed())
        await page.screenshot({ path: `${artifactRoot}/native-preview-failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
  await executor.stop();
}
