import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

const s3 = await objectStorageFixture();
if (!s3) throw new Error("A disposable loopback S3 fixture is required");
const out = process.env.PANDA_ORIGINAL_STORAGE_PROOF || ".artifacts/original-storage-browser";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 90000 }),
  proof = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [chromium, 1440, "zh-CN", "aurora"],
    [webkit, 390, "zh-HK", "silk"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    if (process.env.PANDA_ORIGINAL_STORAGE_LOCALE && process.env.PANDA_ORIGINAL_STORAGE_LOCALE !== locale) continue;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
        isMobile: width < 700,
        hasTouch: width < 700,
        acceptDownloads: true,
      });
      await app.signIn(context);
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window === window.top && location.protocol.startsWith("http")) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
        assert(response.ok(), `API ${path.split("?")[0]} failed: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const before = await api("/api/system/storage");
      await api("/api/system/storage", {
        revision: before.revision,
        operationId: randomUUID(),
        action: "configure",
        mode: "local",
        kinds: ["image", "video"],
      });
      const bucket = "panda-ui-" + randomUUID(),
        created = await s3.request("PUT", "/" + bucket);
      assert.equal(created.status, 200);
      await created.body?.cancel();
      const connectionId = randomUUID();
      await api("/api/system/storage-connections", {
        id: connectionId,
        provider: "s3",
        name: "Originals " + locale,
        bucket,
        region: "us-east-1",
        endpoint: s3.endpoint,
        prefix: "generated",
        forcePathStyle: true,
        ...s3.credentials,
      });
      const page = await context.newPage(),
        errors = [],
        origins = new Set();
      page.setDefaultTimeout(25000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname.startsWith("/api/creative-assets") ||
          new URL(request.url()).pathname.startsWith("/api/system/storage")
        )
          origins.add(new URL(request.url()).origin);
      });
      await page.goto(app.base + "/settings/general-settings");
      if (width < 700) await page.locator('[data-settings-page="general-settings"]').click();
      await page.locator("#themeSelect").selectOption(theme);
      if (width < 700)
        await page
          .locator("#settingsMobileBack:visible, .settings-page:not([hidden]) .settings-mobile-back:visible")
          .first()
          .click();
      await page.locator('[data-settings-page="storage"]').click();
      const panel = page.locator(".original-storage-settings"),
        field = (name) => panel.locator(`[data-storage-field="${name}"]`);
      await field("profileId").waitFor();
      const sheet = await context.request.get(app.base + "/original-storage.css");
      assert.equal(sheet.status(), 200);
      assert.match(sheet.headers()["content-type"], /text\/css/);
      assert.equal(await panel.evaluate((element) => getComputedStyle(element).display), "grid");
      assert.equal(
        await panel
          .locator("fieldset")
          .first()
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
        "0px",
      );
      assert.equal(await page.locator("[data-database-settings]").count(), 1);
      assert.equal(
        await panel.locator('[type="password"],[data-storage-field="bucket"],[data-storage-field="endpoint"]').count(),
        0,
      );
      assert.equal(await panel.locator('a[href="/tools/storage"]').count(), 1);
      await field("profileId").selectOption(connectionId);
      const validation = panel.locator("[data-storage-inline-notice]");
      await panel.locator('[data-storage-kind="image"]').uncheck();
      await panel.locator('[data-storage-kind="video"]').uncheck();
      await panel.locator("[data-storage-save]").click();
      assert((await validation.innerText()).trim().length > 0);
      assert.equal(await field("profileId").inputValue(), connectionId);
      await panel.locator('[data-storage-kind="image"]').check();
      await panel.locator('[data-storage-kind="video"]').check();
      let saves = 0;
      if (locale === "en")
        await page.route("**/api/system/storage", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          saves++;
          const response = await route.fetch();
          assert(response.ok());
          await route.abort("connectionfailed");
        });
      await panel.locator("[data-storage-save]").click();
      if (locale === "en") {
        await panel.locator(".original-storage-recovery").waitFor();
        assert.equal(await field("profileId").isDisabled(), true);
        const receipt = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pf-original-storage-save")));
        assert.deepEqual(Object.keys(receipt).sort(), ["id", "revision"]);
        assert(!JSON.stringify(receipt).includes(s3.credentials.secretAccessKey));
        await panel.locator('[data-storage-action="check"]').click();
        await panel.locator(".original-storage-recovery").waitFor({ state: "hidden" });
        assert.equal(saves, 1);
        await page.unroute("**/api/system/storage");
      }
      await waitFor(async () => (await api("/api/system/storage")).activeProfileId === connectionId);
      assert.equal(await field("profileId").inputValue(), connectionId);
      const loaded = await api("/api/system/storage");
      assert(!JSON.stringify(loaded).includes(s3.credentials.accessKeyId));
      assert(!JSON.stringify(loaded).includes(s3.credentials.secretAccessKey));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await panel.locator("[data-storage-title]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/settings-${locale}-${width}.png` });
      // Real settings navigation retains the saved connection and changes locale.
      const settingsNav = async () => {
        if (width < 700)
          await page
            .locator("#settingsMobileBack:visible, .settings-page:not([hidden]) .settings-mobile-back:visible")
            .first()
            .click();
      };
      await settingsNav();
      await page.locator('[data-settings-page="general-settings"]').click();
      if (locale === "en") {
        await page.locator("#languageSelect").selectOption("zh-CN");
        await waitFor(() =>
          page
            .locator("html")
            .getAttribute("lang")
            .then((value) => value === "zh-CN"),
        );
        await page.locator("#languageSelect").selectOption("en");
      } else if (locale === "zh-HK") {
        await page.locator("#languageSelect").selectOption("zh-TW");
        await waitFor(() =>
          page
            .locator("html")
            .getAttribute("lang")
            .then((value) => value === "zh-TW"),
        );
        await page.locator("#languageSelect").selectOption("zh-HK");
      }
      await settingsNav();
      await page.locator('[data-settings-page="storage"]').click();
      await field("profileId").waitFor();
      assert.equal(await field("profileId").inputValue(), connectionId);
      const catalog = await api("/api/projects"),
        code = "s3-" + locale.toLowerCase(),
        savedProject = await api("/api/projects", {
          name: "Private originals " + locale,
          code,
          revision: catalog.revision,
        }),
        project = savedProject.projects.find((value) => value.code === code);
      const inputs = [
          {
            kind: "image",
            name: "private-image.png",
            bytes: await sharp({ create: { width: 96, height: 64, channels: 3, background: "#168c9b" } })
              .png()
              .toBuffer(),
          },
          {
            kind: "video",
            name: "private-video.mp4",
            bytes: await readFile(new URL("../support/media/preview.mp4", import.meta.url)),
          },
        ],
        saved = [];
      for (const input of inputs) {
        const query = new URLSearchParams({
          project: project.id,
          id: "c-" + randomUUID(),
          operationId: randomUUID(),
          kind: input.kind,
          title: input.name,
          name: input.name,
          locale,
        });
        const response = await context.request.post(app.base + "/api/creative-assets/import?" + query, {
          data: input.bytes,
          headers: { Origin: app.base, "content-type": "application/octet-stream" },
        });
        assert.equal(response.status(), 201, await response.text());
        const value = (await response.json()).asset;
        assert.equal(value.originalStore, "object");
        saved.push(value);
      }
      await page.goto(app.base + "/tools/storage");
      const detailsButton = page.locator(`[data-storage-details-id="${connectionId}"]`);
      await detailsButton.click();
      const details = page.locator('dialog[aria-labelledby="storage-details-title"]');
      await details.getByText(bucket, { exact: true }).waitFor();
      const replacement = details.locator("[data-storage-replace]");
      await replacement.locator("summary").click();
      await replacement.locator('[name="storage-accessKeyId"]').fill(s3.credentials.accessKeyId);
      await replacement.locator('[name="storage-secretAccessKey"]').fill(s3.credentials.secretAccessKey);
      await details.locator('button[type="submit"]').click();
      await details.waitFor({ state: "hidden" });
      const afterKeys = await api("/api/system/storage-connections");
      assert.equal(afterKeys.connections.find((connection) => connection.id === connectionId).credentialRevision, 2);
      assert.deepEqual(await api("/api/system/storage"), loaded);
      await api("/api/system/storage", {
        revision: loaded.revision,
        operationId: randomUUID(),
        action: "placement",
        mode: "local",
        kinds: loaded.kinds,
      });
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-authoring-action="new"]').click();
      const editor = page.locator('.document-rich-content[contenteditable="true"]');
      await editor.waitFor();
      await editor.fill("A preserved editing draft.");
      const directory = async () => {
        if (width < 700 && !(await page.locator("#authoringDirectory").isVisible())) {
          if (
            !(await page
              .locator('[data-authoring-action="directory"]:visible,[data-authoring-action="reader-directory"]:visible')
              .count())
          )
            await page.locator(".document-editor-more > summary").click();
          await page
            .locator('[data-authoring-action="directory"]:visible,[data-authoring-action="reader-directory"]:visible')
            .first()
            .click();
        }
      };
      for (let at = 0; at < saved.length; at++) {
        await directory();
        await page.locator(`[data-file-id="${saved[at].id}"]`).click();
        const dialog = page.locator("#authoringFileDialog[open]");
        await dialog.locator("a[download]").first().waitFor();
        if (at === 0)
          await waitFor(() =>
            dialog.locator("img[data-asset-native]").evaluate((image) => image.complete && image.naturalWidth === 96),
          );
        else {
          await waitFor(() =>
            dialog.locator("video[data-asset-native]").evaluate((video) => video.readyState > 0 && video.duration > 0),
          );
          await dialog.locator("video[data-asset-native]").evaluate((video) => {
            video.currentTime = video.duration / 2;
          });
          await waitFor(() => dialog.locator("video[data-asset-native]").evaluate((video) => !video.seeking));
        }
        const event = page.waitForEvent("download");
        await dialog.locator("a[download]").first().click();
        assert.deepEqual(await readFile(await (await event).path()), inputs[at].bytes);
        await dialog.locator("[data-doc-close]").click();
        assert.match(await editor.innerText(), /preserved editing draft/);
      }
      await directory();
      await page.locator(`[data-file-id="${saved[0].id}"]`).click();
      await page.locator("#authoringFileDialog [data-asset-trash]").click();
      await page.locator('#authoringFileDialog [type="submit"]').click();
      await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-file-action="trash"]').click();
      await page.locator(`[data-file-id="${saved[0].id}"]`).click();
      await page.locator('#authoringFileDialog [type="submit"]:enabled').click();
      await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-file-action="saved"]').click();
      await page.locator(`[data-file-id="${saved[0].id}"]`).click();
      await page.locator("#authoringFileDialog [data-asset-trash]").click();
      await page.locator('#authoringFileDialog [type="submit"]').click();
      await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-file-action="trash"]').click();
      await page.locator(`[data-file-id="${saved[0].id}"]`).click();
      await page.locator("#authoringFileDialog [data-asset-permanent]").click();
      await page.locator('#authoringFileDialog [type="submit"]').click();
      await page.locator("#authoringFileDialog [data-asset-purge-notice]").waitFor();
      await waitFor(
        async () =>
          (await api("/api/creative-assets/purge?" + new URLSearchParams({ project: project.id, id: saved[0].id })))
            .asset.state === "purged",
        30000,
      );
      await waitFor(() => page.locator("#authoringFileDialog [data-asset-purge-actions]").isHidden(), 30000);
      await page.screenshot({ path: `${out}/cleanup-${locale}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual([...origins], [app.base]);
      assert.deepEqual(errors, []);
      proof.push({
        locale,
        width,
        theme,
        realS3Settings: true,
        credentialsManagedSeparately: true,
        oldOriginalsRetainedAfterSwitchingToLocal: true,
        signedInOriginalViewAndDownload: true,
        videoSeek: true,
        trashRestore: true,
        permanentCleanup: true,
        apiOriginsRemainApplication: true,
        draftPreserved: true,
        unknownSaveReceiptRecoveredWithoutRepeat: locale === "en",
        realSettingsLanguageSwitch: ["en", "zh-HK"].includes(locale),
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/checks.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ cases: proof.length, saved: out + "/checks.json" }));
} finally {
  try {
    await app.dispose();
  } finally {
    await s3.close();
  }
}
