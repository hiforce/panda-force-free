import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeFiles, nativeZipSource } from "../support/native-theme.js";

const app = await createAppFixture();
await mkdir(".artifacts/native-template-product", { recursive: true });
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
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await app.signIn(context);
      page = await context.newPage();
      await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
      const errors = [],
        external = [],
        id = `example.native-ui-${width}`,
        archive = await nativeZipSource({
          ...nativeFiles,
          "theme/package.json": JSON.stringify({
            name: engine === "hexo" ? "example-theme" : "docusaurus-theme-example",
            version: "1.0.0",
            author: "Example publisher",
            license: "MIT",
            main: "./index.js",
          }),
          "theme/README.md": "Native theme documentation\n<script>window.nativeThemeInjected = true</script>",
          "theme/index.js": "module.exports = () => ({ name: 'fixture' });",
          "theme/theme/Navbar/index.js": "module.exports = function Navbar() {};",
        });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
      });
      await page.goto(app.base + "/publish/website");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(`[data-publish-format="${engine}"]`).click();
      const center = page.locator(".template-manager"),
        dialog = page.locator("#sourceTemplateImport"),
        form = dialog.locator("[data-source-native-review]"),
        detail = page.locator("#managedTemplateDialog");
      async function configure(version, bytes = archive.bytes) {
        const sourceName = bytes === archive.bytes ? `native-${width}.zip` : `roundtrip-${width}.zip`;
        await center.locator("[data-template-menu] summary").click();
        await center.locator('[data-template-action="source-import"]').click();
        await dialog.locator("[data-source-file]").setInputFiles({
          name: sourceName,
          mimeType: "application/zip",
          buffer: Buffer.from(bytes),
        });
        await dialog.locator("[data-source-submit]:enabled").click();
        const task = dialog
          .locator("[data-source-task]")
          .filter({ has: page.locator("[data-source-name]", { hasText: sourceName }) })
          .first();
        await task.locator('[data-source-action="inspect"]:visible').click();
        await dialog.locator(`[data-source-candidate="${engine}-theme"] [data-source-choose]`).click();
        await form.locator('[data-native-field="id"]:enabled').waitFor();
        assert.equal(await form.locator('[data-native-field="publisher"]').inputValue(), "Example publisher");
        await form.locator('[data-native-field="id"]').fill(id);
        await form.locator('[data-native-field="version"]').fill(version);
        await dialog.locator('[data-source-action="refresh"]').click();
        assert.equal(await form.locator('[data-native-field="id"]').inputValue(), id);
        await form.locator("[data-native-settings] button[type=submit]").click();
        await form.locator("[data-native-code]:enabled").waitFor();
        assert.match(await form.locator("[data-native-approval]").innerText(), /MIT fixture license/);
        assert.equal(await form.locator("[data-native-accept]").evaluate((node) => node.checkValidity()), false);
        await form.locator("[data-native-code]").check();
        assert.equal(await form.locator("[data-native-accept]").evaluate((node) => node.checkValidity()), false);
        await form.locator("[data-native-license]").check();
        assert.equal(await form.locator("[data-native-accept]").evaluate((node) => node.checkValidity()), true);
        assert.equal(await form.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      }
      await configure("1.0.0");
      await page.screenshot({ path: `.artifacts/native-template-product/approval-${width}.png` });
      let first = null,
        attempts = 0;
      await page.route("**/api/templates/native/install", async (route) => {
        attempts++;
        if (attempts !== 1) return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        first = await response.json();
        await route.abort("failed");
      });
      await form.locator("[data-native-accept] button[type=submit]").click();
      await form.locator('[data-native-notice][data-error="true"]').waitFor();
      assert.ok(first);
      const theme = first.current.themes.find((value) => value.id === id),
        reference = { id, version: "1.0.0", digest: theme.digest };
      const disabled = await context.request.put(app.base + "/api/templates/native/state", {
        data: { reference, action: "disable", expectedRevision: first.current.revision },
      });
      assert.equal(disabled.status(), 200);
      const tasks = await (await context.request.get(app.base + "/api/package-sources?purpose=templates")).json(),
        task = tasks.find((value) => value.request.source.name === `native-${width}.zip`);
      assert.ok(task);
      assert.equal(
        (
          await context.request.post(app.base + "/api/package-sources/remove", {
            data: { purpose: "templates", id: task.id, revision: task.revision },
          })
        ).status(),
        200,
      );
      const replayResponse = page.waitForResponse(
        (response) => response.url().endsWith("/api/templates/native/install") && response.status() === 201,
      );
      await form.locator("[data-native-accept] button[type=submit]").click();
      const replay = await (await replayResponse).json();
      assert.deepEqual(replay.receipt, first.receipt);
      assert.equal(replay.current.themes.find((value) => value.id === id).enabled, false);
      await form.locator("[data-native-accept]").waitFor({ state: "hidden" });
      await dialog.locator('[data-source-action="close"]').click();
      const card = (version) => center.locator(`[data-template-key^="native:site-theme:${id}:${version}:"]`);
      await card("1.0.0").click();
      await detail.locator(".native-theme-overview").waitFor();
      assert.equal(await detail.locator('[data-template-detail="preview"]').isVisible(), true);
      assert.equal(await detail.locator('[data-template-detail="export"]').isVisible(), true);
      const download = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const downloaded = await download,
        bundle = new Uint8Array(await readFile(await downloaded.path())),
        bundleFiles = unzipSync(bundle);
      assert.equal(downloaded.suggestedFilename(), `${id}-1.0.0.native-theme.zip`);
      assert.deepEqual(bundleFiles["theme/source/logo.bin"], new Uint8Array([0, 10, 255]));
      assert.equal(Object.hasOwn(bundleFiles, "private.txt"), false);
      assert.match(await detail.locator(".native-theme-overview").innerText(), /native-\d+\.zip/);
      await detail.locator('[data-template-detail="toggle"]:enabled').click();
      await detail.waitFor({ state: "hidden" });
      await card("1.0.0").click();
      await detail.locator('[data-template-detail="activate"]:visible:enabled').click();
      await detail.waitFor({ state: "hidden" });
      await configure("2.0.0");
      await form.locator("[data-native-accept] button[type=submit]").click();
      await form.locator("[data-native-accept]").waitFor({ state: "hidden" });
      await dialog.locator('[data-source-action="close"]').click();
      assert.equal(await center.locator(`[data-template-key^="native:site-theme:${id}:"]`).count(), 1);
      await card("1.0.0").click();
      await detail.locator('[data-template-detail="versions"]:enabled').click();
      await detail.locator('[data-template-version*=":2.0.0:"]').click();
      await detail.locator(".native-theme-overview").waitFor();
      assert.equal(await detail.locator('[data-template-detail="activate"]').isVisible(), true);
      await detail.locator('[data-template-detail="versions"]:enabled').click();
      await detail.locator(".template-version-row").nth(1).waitFor();
      assert.equal(await detail.locator(".template-version-row").count(), 2);
      await detail.locator('[data-template-version*=":1.0.0:"]').click();
      await detail.locator(".native-theme-overview").waitFor();
      assert.equal(await detail.locator('[data-template-detail="activate"]').isVisible(), false);
      await detail.locator('[data-template-detail="close"]').click();
      await configure("3.0.0", bundle);
      await form.locator("[data-native-accept] button[type=submit]").click();
      await form.locator("[data-native-accept]").waitFor({ state: "hidden" });
      await dialog.locator('[data-source-action="close"]').click();
      await card("1.0.0").click();
      await detail.locator('[data-template-detail="versions"]:enabled').click();
      await detail.locator('[data-template-version*=":3.0.0:"]').click();
      await detail.locator('[data-template-detail="activate"]:visible:enabled').click();
      await detail.waitFor({ state: "hidden" });
      await card("3.0.0").waitFor();
      assert.equal(await center.locator(`[data-template-key^="native:site-theme:${id}:"]`).count(), 1);
      assert.equal(await page.evaluate(() => window.nativeThemeInjected), undefined);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `.artifacts/native-template-product/installed-${width}.png` });
      await context.close();
      if (width === 1440) {
        await app.stop();
        await app.start();
      }
      console.log(
        `${browserType.name()} ${width}: ${engine} source configuration, separate approvals, exact lost-response retry after cleanup, private management, versions, binary source export, reviewed re-import and safe documentation passed`,
      );
    } catch (error) {
      if (page) await page.screenshot({ path: `.artifacts/native-template-product/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
