import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { objectStorageFixture } from "../support/object-storage-fixture.js";
const s3 = await objectStorageFixture();
if (!s3) throw new Error("A disposable private S3 fixture is required");
const out = process.env.PANDA_GALLERY_COVERS_PROOF || ".artifacts/creative-gallery-covers";
await mkdir(out, { recursive: true });
let app;
try {
  app = await createAppFixture({ startupTimeoutMs: 90000 });
} catch (error) {
  await s3.close();
  throw error;
}
const records = [],
  assets = [];
let project = "",
  seed = 123456;
const pixels = Buffer.alloc(1400 * 900 * 3);
for (let i = 0; i < pixels.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  pixels[i] = seed & 255;
}
const original = await sharp(pixels, { raw: { width: 1400, height: 900, channels: 3 } })
  .png()
  .toBuffer();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
        assert(response.ok(), await response.text());
        return response.json();
      };
      if (!assets.length) {
        const catalog = await api("/api/projects");
        const created = await api("/api/projects", {
          name: "Gallery fixture",
          code: "gallery-cover",
          revision: catalog.revision,
        });
        project = created.projects.find((entry) => entry.code === "gallery-cover").id;
        for (const mode of ["local", "s3"]) {
          if (mode === "s3") {
            const bucket = "panda-gallery-" + randomUUID();
            const created = await s3.request("PUT", "/" + bucket);
            assert.equal(created.status, 200);
            await created.body?.cancel();
            const config = await api("/api/system/storage");
            await api("/api/system/storage", {
              action: "configure",
              revision: config.revision,
              operationId: randomUUID(),
              mode: "s3",
              kinds: ["image"],
              profile: {
                ...s3.connection(bucket),
                label: "Private originals",
                prefix: "originals",
                credentials: s3.credentials,
              },
            });
          }
          const query = new URLSearchParams({
            project,
            id: "c-" + randomUUID(),
            operationId: randomUUID(),
            kind: "image",
            name: mode + ".png",
            title: mode + " illustration",
            locale: "en",
          });
          const response = await context.request.post(app.base + "/api/creative-assets/import?" + query, {
            data: original,
            headers: { Origin: app.base, "content-type": "application/octet-stream" },
          });
          assert.equal(response.status(), 201, await response.text());
          const saved = (await response.json()).asset;
          assert.equal(saved.originalStore === "object", mode === "s3");
          assets.push(saved);
        }
      }
      const inventory = await api("/api/creative-assets?project=" + project);
      assert.equal(inventory.assets.length, 2, JSON.stringify(inventory));
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.setDefaultTimeout(30000);
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => requests.push(r.url()));
      let failed = false;
      await page.route("**/api/creative-assets/view?*variant=cover", (route) => {
        if (!failed) {
          failed = true;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"fixture unavailable"}',
          });
        }
        return route.continue();
      });
      await page.goto(app.base + "/project?id=" + project);
      await page.locator('[data-creative-filter="image"]').click();
      const cards = page.locator('.creative-card[data-creative-kind="image"]');
      await cards
        .first()
        .waitFor()
        .catch(async (error) => {
          await writeFile(
            out + "/failed-page.private.txt",
            page.url() + "\n" + (await page.locator("body").innerText()) + "\n" + JSON.stringify(errors),
          );
          await page.screenshot({ path: out + "/failed-page.png" });
          throw error;
        });
      await cards.first().scrollIntoViewIfNeeded();
      await page
        .locator("[data-creative-cover-retry]:visible")
        .waitFor()
        .catch(async (error) => {
          await writeFile(
            out + "/failed-cover.private.json",
            JSON.stringify(
              {
                errors,
                requests,
                rows: await cards.evaluateAll((cards) =>
                  cards.map((card) => ({
                    state: card.dataset.coverState,
                    html: card.innerHTML,
                    rect: card.getBoundingClientRect().toJSON(),
                  })),
                ),
              },
              null,
              2,
            ),
          );
          await page.screenshot({ path: out + "/failed-cover.png" });
          throw error;
        });
      await page.locator("[data-creative-cover-retry]:visible").click();
      await waitFor(() =>
        cards.evaluateAll((cards) => cards.length === 2 && cards.every((card) => card.dataset.coverState === "ready")),
      );
      const coverCalls = () =>
        requests.filter((url) => url.includes("/api/creative-assets/view?") && url.includes("variant=cover")).length;
      const count = coverCalls();
      assert.equal(count, 3);
      assert(
        !requests.some(
          (url) =>
            url.includes("/api/creative-assets/content?") ||
            (url.includes("/api/creative-assets/view?") && !url.includes("variant=cover")),
        ),
      );
      for (const img of await cards.locator("img[data-creative-cover]").all())
        assert(await img.evaluate((img) => img.complete && img.naturalWidth <= 512 && img.naturalHeight <= 320));
      const target = assets[0];
      await page.locator("[data-creative-search]").fill("local illustration");
      assert.equal(await cards.count(), 1);
      await page.locator("[data-creative-search]").fill("");
      assert.equal(await cards.count(), 2);
      for (const next of [locale === "en" ? "zh-CN" : "en", locale]) {
        await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
        if (width < 768) await page.locator('[data-chrome-action="menu"][data-value="language"]').click();
        await page.locator(`[data-chrome-action="locale"][data-value="${next}"]`).click();
        await waitFor(() =>
          page
            .locator("html")
            .getAttribute("lang")
            .then((value) => value === next),
        );
      }
      await waitFor(() => cards.evaluateAll((cards) => cards.every((card) => card.dataset.coverState === "ready")));
      assert.equal(coverCalls(), count);
      assert.equal(await page.locator("[data-creative-search]").inputValue(), "");
      for (const asset of assets) {
        const response = await context.request.get(
          app.base +
            "/api/creative-assets/view?" +
            new URLSearchParams({ project, id: asset.id, version: asset.version, variant: "cover" }),
        );
        assert(response.ok());
        assert.equal(response.headers()["cache-control"], "private, no-store");
        assert((await response.body()).length < original.length / 5);
      }
      await cards.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/gallery-${locale}-${width}.png` });
      await page.locator(`[data-creative-asset="${target.id}"]`).focus();
      await page.keyboard.press("Enter");
      const dialog = page.locator(".creative-asset-dialog[open]");
      await waitFor(() =>
        dialog.locator("img[data-asset-native]").evaluate((img) => img.complete && img.naturalWidth === 1400),
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.locator("[data-creative-search]").fill("local");
      await page.goto(app.base + "/workspace");
      assert.equal(await page.locator("img[data-creative-cover]").count(), 0);
      const anon = await fetch(
        app.base +
          "/api/creative-assets/view?" +
          new URLSearchParams({ project, id: target.id, version: target.version, variant: "cover" }),
        { redirect: "manual" },
      );
      assert.equal(anon.status, 401);
      await anon.body?.cancel();
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      records.push({
        locale,
        width,
        localAndPrivateS3: true,
        boundedRealWebP: true,
        noOriginalBeforeIntent: true,
        failedCoverRetry: true,
        filtersAndLocaleReuse: true,
        keyboardOriginalViewer: true,
        anonymousDenied: true,
        storageRulesRequired: false,
        overflow: false,
        errors: 0,
      });
      console.log("Gallery thumbnails verified", locale, width);
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/checks.json", JSON.stringify({ passed: true, records, modelInference: false }, null, 2));
} finally {
  try {
    await app.dispose();
  } finally {
    await s3.close();
  }
}
