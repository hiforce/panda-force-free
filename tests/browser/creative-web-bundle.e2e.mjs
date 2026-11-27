import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { zipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { readSourceZip } from "../../src/server/packages/zip/read.js";

const app = await createAppFixture({ applicationCreation: true }),
  out = ".artifacts/creative-web-bundle";
await mkdir(out, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: width > 700 ? "light" : "dark",
      });
    let releaseOld = () => {};
    try {
      await app.signIn(context);
      let project = "personal";
      if (width > 700) {
        const catalog = await (await context.request.get(app.base + "/api/projects")).json(),
          created = await context.request.post(app.base + "/api/projects", {
            data: { name: "Web originals", code: "web-bundle", revision: catalog.revision },
          });
        assert.equal(created.status(), 201);
        project = (await created.json()).projects.find((row) => row.code === "web-bundle").id;
      }
      const path = project === "personal" ? "/create" : "/project?id=" + project + "&kind=web",
        page = await context.newPage(),
        errors = [],
        requests = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().includes("external.invalid")) requests.push(request.url());
      });
      await page.goto(app.base + path);
      await page.locator(project === "personal" ? "[data-creative-import]" : ".project-gallery-upload").click();
      const dialog = page.locator(".creative-asset-dialog[open]"),
        file = dialog.locator('[name="document-source"]'),
        submit = dialog.locator('[type="submit"]');
      let held = false;
      const gate = new Promise((resolve) => {
        releaseOld = resolve;
      });
      await page.route("**/api/creative-assets/bundle-inspection?**", async (route) => {
        if (!held) {
          held = true;
          const response = await route.fetch();
          await gate;
          await route.fulfill({ response });
        } else await route.continue();
      });
      await file.setInputFiles({
        name: "earlier.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(zipSync({ "old.html": Buffer.from("Old choice") })),
      });
      await waitFor(() => held);
      const files = {
        "site/home.html": Buffer.from(
          '<!doctype html><html lang="en"><head><link rel="stylesheet" href="css/main.css"></head><body><header><img src="media/mark.png" alt="Panda"><span>FIELD NOTES / 2026</span></header><main><p class="eyebrow">BUILDING WITH INTENT</p><h1>Ideas worth keeping.</h1><p class="intro">A saved original brings its words, images and visual language together.</p><section><h2>One complete source</h2><p>Read the original. Follow its evidence. Keep every resource close.</p><span class="tag">Product · Engineering · Craft</span><img src="media/shape.svg" width="24" height="24" alt="Shape"></section></main><script>window.bundleScriptExecuted=true</script></body></html>',
        ),
        "site/about.html": Buffer.from("<h1>About this original</h1>"),
        "site/css/main.css": Buffer.from(
          '@import "colors.css";@import "https://external.invalid/remote.css";*{box-sizing:border-box}body{margin:0;padding:36px;background:var(--paper);font-family:Georgia,serif;color:var(--ink)}header{display:flex;align-items:center;gap:14px;border-bottom:1px solid #cbc8bb;padding-bottom:20px;font:12px system-ui;letter-spacing:.14em}header img{width:44px;height:44px}main{padding-top:42px}.eyebrow{font:11px system-ui;letter-spacing:.15em;color:#62695f}h1{font-size:clamp(38px,7vw,74px);font-weight:500;line-height:1.05;margin:22px 0}.intro{font:18px/1.7 system-ui;max-width:560px;color:#59655c}section{border-top:1px solid #cbc8bb;margin-top:40px;padding-top:26px;max-width:660px}h2{font-size:25px;font-weight:500}.tag{font:11px system-ui;letter-spacing:.08em}section p{font:14px/1.8 system-ui}@media(max-width:600px){body{padding:24px}main{padding-top:28px}}',
        ),
        "site/css/colors.css": Buffer.from(
          ":root{--paper:rgb(246,242,232);--ink:rgb(14,48,64)}h1{color:rgb(14,48,64)}",
        ),
        "site/media/mark.png": new Uint8Array(await readFile("public/assets/panda-icon.png")),
        "site/media/shape.svg": Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="navy"/><script>parent.postMessage("bundle-svg-ran","*")</script><image href="https://external.invalid/svg-resource"/></svg>',
        ),
        "site/empty.css": new Uint8Array(),
      };
      const inspected = page.waitForResponse(
        (response) => response.url().includes("/api/creative-assets/bundle-inspection?") && response.status() === 200,
      );
      await file.setInputFiles({
        name: "website.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(zipSync(files)),
      });
      await inspected;
      const entry = dialog.locator('[name="document-entry"]');
      await waitFor(() => entry.isEnabled());
      releaseOld();
      await waitFor(async () => (await entry.locator("option").count()) === 3);
      assert.equal(await entry.inputValue(), "");
      assert.equal(await submit.isDisabled(), true);
      await entry.selectOption("site/home.html");
      await dialog.locator('[name="document-title"]').fill("Field notes " + width);
      assert.equal(await dialog.locator("[data-asset-bundle-retry]").isVisible(), false);
      assert.equal(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
      await page.screenshot({ path: out + "/import-" + width + ".png" });
      const imported = page.waitForResponse(
        (response) =>
          response.url().includes("/api/creative-assets/import-bundle?") && response.request().method() === "POST",
      );
      await submit.click();
      const response = await imported;
      assert.equal(response.status(), 201, await response.text());
      const asset = (await response.json()).asset;
      assert.equal(asset.source.name, "site/home.html");
      assert.equal(asset.resources.length, Object.keys(files).length - 1);
      await dialog.waitFor({ state: "hidden" });
      await page.locator(`[data-creative-asset="${asset.id}"]`).click();
      const viewer = project === "personal" ? dialog : page.locator("[data-project-asset-reader]");
      const frame = viewer.frameLocator("[data-asset-frame]");
      await frame.locator("h1").waitFor();
      assert.equal(await viewer.locator("[data-asset-frame]").getAttribute("sandbox"), "");
      assert.equal(await frame.locator("h1").evaluate((element) => getComputedStyle(element).color), "rgb(14, 48, 64)");
      assert.equal(
        await frame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(246, 242, 232)",
      );
      await waitFor(() =>
        frame.locator("header img").evaluate((element) => element.complete && element.naturalWidth > 0),
      );
      assert.equal(await frame.locator("body").evaluate(() => typeof window.bundleScriptExecuted), "undefined");
      const imageBox = await frame.locator("header img").boundingBox();
      assert.ok(imageBox && imageBox.width >= 40 && imageBox.height >= 40, JSON.stringify(imageBox));
      assert.equal(
        await frame.locator("html").evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
      );
      await frame.locator("header img").evaluate(async (element) => {
        await Promise.race([
          element.decode(),
          new Promise((_, reject) => setTimeout(() => reject(Error("Preview image decode did not settle")), 5000)),
        ]);
      });
      await waitFor(() =>
        frame.locator('img[alt="Shape"]').evaluate((element) => element.complete && element.naturalWidth > 0),
      );
      assert.deepEqual(requests, []);
      await page.screenshot({ path: out + "/preview-" + width + ".png" });
      const download = await viewer.locator('a[href*="export-bundle"]').getAttribute("href");
      assert.equal(new URL(download, app.base).searchParams.get("version"), asset.version);
      const exported = await context.request.get(app.base + download);
      assert.equal(exported.status(), 200);
      const retained = await readSourceZip(new Uint8Array(await exported.body()));
      assert.deepEqual(
        retained.files.map((row) => row.path),
        Object.keys(files).sort(),
      );
      for (const [name, bytes] of Object.entries(files)) assert.deepEqual(retained.read(name), new Uint8Array(bytes));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        scope: project === "personal" ? "personal" : "project",
        lateInspectionFenced: true,
        explicitHomepageSelection: true,
        localCssImportsImagesAndSandbox: true,
        noExternalRequestsOrScripts: true,
        exportExactNamesBytesAndVersion: true,
      });
    } finally {
      releaseOld();
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/result.json", JSON.stringify({ passed: true, records }, null, 2) + "\n");
} finally {
  await app.dispose();
}
