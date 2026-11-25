import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

const s3 = await objectStorageFixture();
if (!s3) throw Error("A disposable S3 fixture is required");
const app = await createAppFixture({ startupTimeoutMs: 90000 }),
  out = process.env.PANDA_DIRECT_ORIGINALS_PROOF || ".artifacts/direct-originals-browser",
  records = [];
await mkdir(out, { recursive: true });
let assets, local;
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
        isMobile: width < 768,
        hasTouch: width < 768,
        acceptDownloads: true,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const api = async (path, data) => {
        const response = await context.request.fetch(app.base + path, {
          method: data ? "POST" : "GET",
          headers: { Origin: app.base },
          ...(data ? { data } : {}),
        });
        assert(response.ok(), "Fixture API failed: " + path.split("?")[0] + " " + response.status());
        return response.json();
      };
      if (!assets) {
        const png = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#168c9b" } })
            .png()
            .toBuffer(),
          inputs = [
            { kind: "image", name: "插画.png", bytes: png },
            {
              kind: "video",
              name: "video.mp4",
              bytes: await readFile(new URL("../support/media/preview.mp4", import.meta.url)),
            },
          ],
          save = async (input) => {
            const q = new URLSearchParams({
              project: "personal",
              id: "c-" + randomUUID(),
              operationId: randomUUID(),
              kind: input.kind,
              title: input.name,
              name: input.name,
              locale: "en",
            });
            const r = await context.request.post(app.base + "/api/creative-assets/import?" + q, {
              data: input.bytes,
              headers: { Origin: app.base, "content-type": "application/octet-stream" },
            });
            assert.equal(r.status(), 201);
            return { asset: (await r.json()).asset, bytes: input.bytes };
          };
        local = await save({ ...inputs[0], name: "local.png" });
        const bucket = "panda-direct-" + randomUUID(),
          created = await s3.request("PUT", "/" + bucket);
        assert.equal(created.status, 200);
        await created.body?.cancel();
        const settings = await api("/api/system/storage");
        await api("/api/system/storage", {
          action: "configure",
          revision: settings.revision,
          operationId: randomUUID(),
          mode: "s3",
          kinds: ["image", "video"],
          profile: {
            ...s3.connection(bucket),
            prefix: "originals",
            label: "Private fixture",
            credentials: s3.credentials,
          },
        });
        assets = [];
        for (const input of inputs) assets.push(await save(input));
      }
      const page = await context.newPage(),
        errors = [],
        redirects = [],
        objectResponses = [];
      page.setDefaultTimeout(35000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.url().startsWith(s3.endpoint))
          objectResponses.push({
            status: response.status(),
            type: response.request().resourceType(),
            mime: response.headers()["content-type"],
          });
        if (new URL(response.url()).pathname === "/api/creative-assets/view" && response.status() === 307)
          redirects.push(response);
      });
      let linkRequests = 0,
        failFirst = locale === "en";
      await page.route("**/api/creative-assets/link?*", async (route) => {
        linkRequests++;
        await Bun.sleep(100);
        if (failFirst) {
          failFirst = false;
          return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
        }
        return route.continue();
      });
      for (const { asset, bytes } of assets) {
        await page.goto(app.base + "/create?view=works&category=" + asset.kind);
        await page.locator('[data-file-id="' + asset.id + '"]').click();
        const dialog = page.locator("[data-personal-reader]:visible"),
          native = dialog.locator("[data-asset-native]");
        await native.waitFor();
        if (asset.kind === "image")
          await waitFor(() => native.evaluate((image) => image.complete && image.naturalWidth === 1000));
        else {
          await waitFor(() => native.evaluate((video) => video.readyState > 0 && video.duration > 0));
          await native.evaluate(async (video) => {
            video.muted = true;
            await video.play();
            video.pause();
            video.currentTime = video.duration / 2;
          });
          await waitFor(() => native.evaluate((video) => !video.seeking));
        }
        assert.equal(await dialog.locator("[data-asset-link]").isVisible(), false);
        const source = await native.getAttribute("src"),
          before = linkRequests,
          get = dialog.locator("[data-asset-get-link]");
        await dialog.locator(".personal-asset-more > summary").click();
        if (width < 768) assert((await get.boundingBox()).height >= 44);
        await get.click();
        if (locale === "en" && asset.kind === "image") {
          await waitFor(() => get.isEnabled());
          await get.click();
        }
        const field = dialog.locator("[data-asset-link-url]");
        await field.waitFor();
        const signed = await field.inputValue(),
          url = new URL(signed);
        assert.equal(url.origin, s3.endpoint);
        assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
        assert(!signed.includes(s3.credentials.secretAccessKey));
        assert((await dialog.locator("[data-asset-link-notice]").innerText()).includes("24"));
        const count = linkRequests;
        assert(count > before);
        await get.click();
        assert.equal(linkRequests, count);
        assert.equal(await field.inputValue(), signed);
        assert.equal(await native.getAttribute("src"), source);
        if (asset.kind === "video") assert((await native.evaluate((video) => video.currentTime)) > 0);
        const beforeCopy = linkRequests,
          expiredUi = locale === "zh-TW" && asset.kind === "image";
        if (expiredUi) await page.clock.setFixedTime(Date.now() + 86400000);
        await dialog.locator("[data-asset-link-copy]").click();
        await waitFor(async () => Boolean(await dialog.locator("[data-asset-link-copied]").innerText()));
        if (expiredUi) {
          await waitFor(() => linkRequests === beforeCopy + 1);
          await page.clock.setFixedTime(Date.now());
        }
        if (asset.kind === "image") await page.screenshot({ path: `${out}/link-${locale}-${width}.png` });
        const downloaded = page.waitForEvent("download");
        await dialog.locator("a[download]").first().click();
        assert.deepEqual(await readFile(await (await downloaded).path()), bytes);
        const fresh = await api(
          "/api/creative-assets/link?" +
            new URLSearchParams({ project: asset.project, id: asset.id, version: asset.version }),
        );
        assert.equal(fresh.url, signed);
        await page.locator('[data-authoring-action="close-content"]').click();
        await dialog.waitFor({ state: "hidden" });
      }
      await page.goto(app.base + "/create?view=works&category=image");
      await page.locator('[data-file-id="' + local.asset.id + '"]').click();
      const localDialog = page.locator("[data-personal-reader]:visible");
      await waitFor(() =>
        localDialog.locator("img[data-asset-native]").evaluate((image) => image.complete && image.naturalWidth > 0),
      );
      assert.equal(await localDialog.locator("[data-asset-get-link]").count(), 0);
      await page.locator('[data-authoring-action="close-content"]').click();
      for (const next of [locale === "en" ? "zh-CN" : "en", locale]) {
        await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
        if (width < 768) await page.locator('[data-chrome-action="menu"][data-value="language"]').click();
        await page.locator(`[data-chrome-action="locale"][data-value="${next}"]`).click();
        await page.waitForFunction((next) => document.documentElement.lang === next, next);
      }
      assert(redirects.length >= 2);
      for (const { asset } of assets) {
        const grant = await context.request.get(
          app.base +
            "/api/creative-assets/view?" +
            new URLSearchParams({ project: asset.project, id: asset.id, version: asset.version }),
          { maxRedirects: 0 },
        );
        assert.equal(grant.status(), 307);
        assert.equal((await grant.body()).byteLength, 0);
        assert.equal(grant.headers()["content-length"], "0");
      }
      assert(objectResponses.some((r) => r.type === "image" && r.status === 200));
      assert(objectResponses.some((r) => r.mime?.startsWith("video/") && [200, 206].includes(r.status)));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        realPrivateS3: true,
        applicationOriginalResponsesEmpty: true,
        anonymousLinkNotRequestedAutomatically: true,
        getLinkAndExpiry: true,
        reusedLink: true,
        copy: true,
        videoSeekAndPlaybackPreserved: true,
        exactDownloads: true,
        localUnchanged: true,
        languageSwitch: true,
        retry: locale === "en",
        errors: 0,
      });
      console.log("Direct originals verified", locale, width);
    } finally {
      await browser.close();
    }
  }
  const asset = assets[0].asset,
    anonymous = await fetch(
      app.base +
        "/api/creative-assets/link?" +
        new URLSearchParams({ project: asset.project, id: asset.id, version: asset.version }),
    );
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();
  await writeFile(out + "/checks.json", JSON.stringify({ passed: true, records, anonymousStatus: 401 }, null, 2));
} finally {
  try {
    await app.dispose();
  } finally {
    await s3.close();
  }
}
