import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture } from "../support/app-fixture.mjs";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.js";

const out = process.env.PANDA_PERSONAL_LIBRARY_PROOF || ".artifacts/personal-creation-library";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
const gallery = await Promise.all(
  ["science-illustration", "information-architecture", "short-film-storyboard"].map((name) =>
    sharp("public/assets/skill-cover-" + name + "-v1.webp")
      .resize(360, 240)
      .png()
      .toBuffer(),
  ),
);
const imageBytes = gallery[0];
const videoFixture = Bun.spawn(
  [
    "ffmpeg",
    "-v",
    "error",
    "-threads",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-i",
    "pipe:0",
    "-frames:v",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ],
  { stdin: gallery[2], stdout: "pipe" },
);
const videoBytes = Buffer.from(await new Response(videoFixture.stdout).arrayBuffer());
assert.equal(await videoFixture.exited, 0);
const deck = await renderCreationSlides(
  [
    { layout: "picture", title: "Illustrated slide", body: "Original layout and image", imageHandle: "1".repeat(64) },
    { layout: "content", title: "Second slide", body: "Turn the page on the web." },
  ],
  async () => imageBytes,
);
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1190, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    if (process.env.PANDA_PERSONAL_LIBRARY_LOCALE && process.env.PANDA_PERSONAL_LIBRARY_LOCALE !== locale) continue;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 920 },
        locale,
        isMobile: width < 700,
        hasTouch: width < 700,
        acceptDownloads: true,
      });
      await context.addInitScript((locale) => {
        if (window !== top || !/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", locale === "en" ? "light" : "aurora");
      }, locale);
      await app.signIn(context);
      const api = async (path, data, contentType) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, {
                data,
                headers: { Origin: app.base, ...(contentType ? { "content-type": contentType } : {}) },
              });
        assert.ok(response.ok(), await response.text());
        return response.json();
      };
      const tree = await api("/api/personal/project-document-tree?project=personal"),
        title = "Library field notes " + locale,
        created = await api("/api/personal/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: "personal",
          treeVersion: tree.version,
          title,
          locale,
          parentId: null,
        }),
        id = created.operation.documentId;
      const importAsset = (kind, name, data) =>
        api(
          "/api/creative-assets/import?" +
            new URLSearchParams({
              project: "personal",
              kind,
              name,
              title: name,
              locale,
              id: "c-" + crypto.randomUUID(),
              operationId: crypto.randomUUID(),
            }),
          data,
          "application/octet-stream",
        );
      const { asset: image } = await importAsset(
        "image",
        "Natural structures — illustrated field guide " + locale + ".png",
        imageBytes,
      );
      if (locale === "en") {
        await importAsset("image", "Transit and connections.png", gallery[1]);
        await importAsset("image", "Harbour at dusk.png", gallery[2]);
      }
      const { asset: video } = await importAsset("video", "Harbour storyboard " + locale + ".mp4", videoBytes);
      const { asset: web } = await importAsset(
        "web",
        "entry-" + locale + ".html",
        Buffer.from("<!doctype html><html><body><h1>Library webpage</h1></body></html>"),
      );
      const { asset: slides } = await importAsset("slides", "slides-" + locale + ".pptx", deck.bytes);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const reader = page.locator("[data-personal-reader]"),
        list = page.locator("[data-personal-list]"),
        close = page.locator('[data-authoring-action="close-content"]');
      const choose = async (category) => {
        if (width < 700) await list.locator('[data-authoring-action="directory"]').click();
        await page.locator(`[data-personal-category="${category}"]`).click();
        assert.equal(await page.locator(`[data-personal-category="${category}"]`).getAttribute("aria-pressed"), "true");
      };
      const listHeader = list.locator(".personal-library-heading");
      const checkListToolbar = async (action, hasSearch = true) => {
        await page.waitForFunction(() => {
          const heading = document.querySelector(".personal-library-heading");
          return heading && getComputedStyle(heading).display === "flex";
        });
        const bounds = await listHeader.boundingBox();
        assert(bounds.height <= (width < 700 ? 104 : 56), `${locale}: unexpected toolbar height ${bounds.height}`);
        const group = listHeader.locator(".personal-library-navigation");
        const title = group.getByRole("heading");
        assert((await title.innerText()).trim());
        const search = listHeader.locator("#documentSearch");
        assert.equal(await search.isVisible(), hasSearch);
        const control = listHeader.locator(action);
        await control.waitFor();
        const box = await control.boundingBox();
        assert(box.height >= (width < 700 ? 44 : 40));
        if (hasSearch) {
          const field = await search.boundingBox();
          assert(field.height >= (width < 700 ? 44 : 40));
          assert(await search.evaluate((input) => parseFloat(getComputedStyle(input).paddingInlineStart) >= 36));
          assert(Math.abs(field.y + field.height / 2 - box.y - box.height / 2) < 1);
          assert(field.x + field.width < box.x);
        }
        if (width < 700) {
          const anchors = await group.locator("a").evaluateAll((nodes) =>
            nodes.map((node) => {
              const { y, width, height } = node.getBoundingClientRect();
              return { y, width, height, label: node.getAttribute("aria-label"), icon: !!node.querySelector("svg") };
            }),
          );
          assert.equal(anchors.length, 2);
          assert(
            anchors.every(
              (anchor) => anchor.label && anchor.icon && anchor.width === anchor.height && anchor.height >= 44,
            ),
          );
          const category = await group.locator("button").boundingBox();
          assert(
            anchors.every((anchor) => Math.abs(anchor.y + anchor.height / 2 - category.y - category.height / 2) < 1),
          );
          if (hasSearch) {
            assert.equal(box.width, box.height);
            assert.equal((await control.innerText()).trim(), "");
            assert(await control.getAttribute("aria-label"));
          }
        }
      };
      const mode = listHeader.locator("[data-personal-toggle-view]");
      const thumbnail = async (item) => {
        const card = item.locator("xpath=..");
        const thumb = card.locator("img[data-creative-cover]");
        await card.scrollIntoViewIfNeeded();
        await thumb.waitFor({ timeout: 55000 });
        assert((await thumb.evaluate((img) => img.naturalWidth)) >= 200);
        const metadata = card.locator(".personal-work-caption small");
        assert(await metadata.evaluate((line) => line.scrollWidth <= line.clientWidth), "Format and date fit the card");
        return card;
      };
      const toolbar = reader.locator(".personal-library-reader-bar");
      const checkToolbar = async (name) => {
        assert.equal(await toolbar.getByRole("heading").innerText(), name);
        assert.equal(
          await reader.locator(".document-editor-header:visible, .authoring-reader-tools:visible").count(),
          0,
        );
        await page.waitForFunction(() => {
          const bar = document.querySelector(".personal-library-reader-bar");
          return bar && getComputedStyle(bar).getPropertyValue("--reader-action-size");
        });
        const bar = await toolbar.boundingBox();
        assert(bar.height <= 56, "Reader uses one row: " + JSON.stringify(bar));
        const icons = await toolbar.locator(".creative-reader-action:visible").evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return {
              x,
              y,
              width,
              height,
              tooltip: node.dataset.tooltip,
              label: node.getAttribute("aria-label"),
              svg: !!node.querySelector("svg"),
              text: node.textContent.trim(),
            };
          }),
        );
        assert(icons.length >= 3);
        assert(
          icons.every(
            (icon) =>
              icon.label &&
              icon.tooltip &&
              icon.svg &&
              !icon.text &&
              icon.y === icons[0].y &&
              icon.width === icon.height &&
              icon.width >= (width < 700 ? 44 : 32),
          ),
        );
      };
      const screenshot = async (name) => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `${out}/${name}-${locale}-${width}.png` });
      };
      await page.goto(app.base + "/create?view=works");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const row = list.locator(`[data-personal-document="${id}"]`);
      await row.waitFor();
      assert.equal(
        await page
          .locator(
            '#authoringDirectory [data-personal-document], #authoringDirectory .authoring-files, [data-tree-action="root"]',
          )
          .count(),
        0,
      );
      assert.equal(await reader.isVisible(), false);
      await checkListToolbar("[data-personal-new]");
      assert.equal(await row.evaluate((button) => !!button.closest(".personal-works-grid")), true);
      await screenshot("document-cards");
      await mode.click();
      await list.locator(".authoring-files-item[data-personal-document]").first().waitFor();
      await page.reload();
      await list.locator(".authoring-files-item[data-personal-document]").first().waitFor();
      await checkListToolbar("[data-personal-new]");
      await screenshot("document-list");
      await mode.click();
      await list.locator(".personal-work-open[data-personal-document]").first().waitFor();
      if (width < 700) {
        const directory = listHeader.locator('[data-authoring-action="directory"]');
        await directory.press("Enter");
        await page.locator('#authoringDirectory[role="dialog"]').waitFor();
        assert.equal(await directory.getAttribute("aria-expanded"), "true");
        await page.keyboard.press("Escape");
        assert.equal(await directory.getAttribute("aria-expanded"), "false");
        assert.equal(await directory.evaluate((element) => element === document.activeElement), true);
        assert.equal(
          await listHeader.locator('a[href="/create"]').getAttribute("aria-label"),
          await page.evaluate(() => globalThis.__pandaForceI18n.t("creative.backCreate")),
        );
      }
      await list.locator("#documentSearch").fill(title);
      await row.focus();
      await page.keyboard.press("Enter");
      await page.locator("#documentReadTitle").waitFor();
      assert.equal(await page.locator("#documentReadTitle").innerText(), title);
      await checkToolbar(title);
      await screenshot("document");
      const docMore = toolbar.locator(".document-editor-more > summary");
      if (width >= 700) {
        await docMore.hover();
        assert.equal(await docMore.evaluate((node) => getComputedStyle(node, "::after").display), "block");
      }
      await docMore.focus();
      await docMore.press("Enter");
      await toolbar.locator('[data-authoring-action="copy-content"]').waitFor();
      await docMore.press("Escape");
      assert.equal(await toolbar.locator(".creative-reader-more").getAttribute("open"), null);
      await page.goBack();
      await list.waitFor();
      assert.equal(await list.locator("#documentSearch").inputValue(), title);
      await page.goForward();
      await page.locator("#documentReadTitle").waitFor();
      await close.click();
      assert.equal(await row.evaluate((element) => element === document.activeElement), true);

      const coverRequests = (url) =>
        url.pathname === "/api/creative-assets/view" &&
        url.searchParams.get("id") === image.id &&
        url.searchParams.get("variant") === "cover";
      if (locale === "en")
        await page.route(coverRequests, (route) => route.fulfill({ status: 503, body: "" }), { times: 1 });
      await choose("image");
      const imageRow = list.locator(`[data-file-id="${image.id}"]`);
      await imageRow.waitFor();
      if (locale === "en") {
        const retry = imageRow.locator("xpath=..").locator("[data-creative-cover-retry]");
        await retry.click();
        await thumbnail(imageRow);
      }
      assert.equal(await list.locator(`[data-file-id="${web.id}"]`).count(), 0);
      await checkListToolbar("[data-personal-import]");
      const imageSearch = list.locator("#documentSearch");
      await imageSearch.fill("No matching image");
      await imageRow.waitFor({ state: "detached" });
      await imageSearch.fill("");
      await imageRow.waitFor();
      assert.equal(await list.locator(".authoring-files-heading").count(), 0);
      const imageCard = await thumbnail(imageRow);
      assert.equal(await imageCard.getAttribute("data-work-kind"), "image");
      await listHeader.scrollIntoViewIfNeeded();
      await screenshot("images");
      await mode.click();
      await list.locator(".authoring-files-item[data-file-id]").first().waitFor();
      assert.equal(await list.locator(".personal-works-grid:visible").count(), 0);
      await mode.click();
      await thumbnail(imageRow);
      if (locale === "en") {
        let releaseRead, startRead;
        const paused = new Promise((resolve) => (releaseRead = resolve)),
          started = new Promise((resolve) => (startRead = resolve));
        await page.route(
          "**/api/creative-assets/item?*",
          async (route) => {
            startRead();
            await paused;
            await route.continue().catch(() => {});
          },
          { times: 1 },
        );
        await imageRow.click();
        await started;
        await close.click();
        releaseRead();
        assert.equal(await reader.isVisible(), false);
        assert.equal(await imageRow.evaluate((element) => element === document.activeElement), true);
      }
      await imageRow.click();
      const preview = reader.locator("img[data-asset-native]");
      await preview.waitFor();
      await preview.evaluate((node) => node.decode());
      assert.equal(await page.locator("dialog.creative-asset-dialog[open]").count(), 0);
      await checkToolbar(image.title);
      const toolbarBounds = await toolbar.boundingBox(),
        previewBounds = await preview.boundingBox();
      await screenshot("image-open");
      assert(toolbarBounds.height <= 56, "Reader uses a single toolbar " + JSON.stringify(toolbarBounds));
      assert(
        previewBounds.y - toolbarBounds.y - toolbarBounds.height <= 24,
        "Preview starts immediately under the toolbar",
      );
      const more = toolbar.locator(".personal-asset-more > summary");
      await more.click();
      assert(await toolbar.locator(".creative-asset-facts").isVisible());
      if (locale === "zh-TW") {
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
        await toolbar.getByText("Saved version", { exact: true }).waitFor();
        await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-TW"));
        await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
      }
      await more.press("Escape");
      assert.equal(await toolbar.locator(".creative-asset-facts").isVisible(), false);
      const downloadPromise = page.waitForEvent("download");
      await reader.locator("a[download]").click();
      const download = await downloadPromise;
      assert.deepEqual(await readFile(await download.path()), imageBytes);
      await close.click();
      assert.equal(await imageRow.evaluate((element) => element === document.activeElement), true);

      await choose("slides");
      await checkListToolbar("[data-personal-import]");
      const slideRow = list.locator(`[data-file-id="${slides.id}"]`);
      await thumbnail(slideRow);
      await listHeader.scrollIntoViewIfNeeded();
      await screenshot("slide-cards");
      await slideRow.click();
      const slideImage = reader.locator("[data-slide-image]");
      await slideImage.waitFor({ timeout: 55000 });
      const firstImage = await slideImage.evaluate((img) => img.src);
      assert((await slideImage.evaluate((img) => img.naturalWidth)) >= 1000);
      assert(
        (await slideImage.evaluate((img) => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext("2d");
          context.drawImage(img, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const [red, green, blue] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            if (Math.max(red, green, blue) - Math.min(red, green, blue) > 100) visible++;
          }
          return visible;
        })) > 1000,
        "Raster contains the image embedded in the source slide",
      );
      await checkToolbar(slides.title);
      assert.equal(await toolbar.locator("a[download] svg").count(), 1);
      await screenshot("slides");
      if (locale === "en") {
        const slideQuery = (page) =>
          app.base +
          "/api/creative-assets/slide-preview?" +
          new URLSearchParams({ project: slides.project, id: slides.id, version: slides.version, page: String(page) });
        const stale = await context.request.get(slideQuery(1).replace(slides.version, "0".repeat(64)));
        assert.equal(stale.status(), 409);
        const missing = await context.request.get(slideQuery(3));
        assert.equal(missing.status(), 404);
        const anonymous = await browser.newContext();
        try {
          assert.equal((await anonymous.request.get(slideQuery(1))).status(), 401);
        } finally {
          await anonymous.close();
        }
      }
      if (locale === "en") {
        await page.route(
          "**/api/creative-assets/slide-preview?*page=2",
          (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
          { times: 1 },
        );
        await reader.locator("[data-slide-next]").click();
        const retry = reader.locator("[data-slide-retry]");
        await retry.waitFor();
        assert.equal(await slideImage.evaluate((img) => img.src), firstImage);
        await retry.click();
      } else await reader.locator("[data-slide-next]").click();
      await page.waitForFunction((first) => {
        const img = document.querySelector("[data-slide-image]");
        return img?.src !== first && img?.complete && img?.naturalWidth > 0;
      }, firstImage);
      assert(await reader.locator("[data-slide-next]").isDisabled());
      assert(await reader.locator("[data-slide-previous]").isEnabled());
      await reader.locator("[data-slide-previous]").click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-slide-previous]")?.disabled &&
          !document.querySelector("[data-slide-next]")?.disabled,
      );
      await reader.locator("[data-slide-text] summary").click();
      await reader.getByText("Original layout and image", { exact: false }).waitFor();
      await close.click();

      await choose("web");
      await checkListToolbar("[data-personal-import]");
      await list.locator(`[data-file-id="${web.id}"]`).click();
      const iframe = reader.locator("[data-asset-frame]");
      await iframe.waitFor();
      assert.equal(await iframe.getAttribute("sandbox"), "");
      assert.equal(await reader.frameLocator("[data-asset-frame]").locator("h1").innerText(), "Library webpage");
      await close.click();
      await choose("video");
      await checkListToolbar("[data-personal-import]");
      await thumbnail(list.locator(`[data-file-id="${video.id}"]`));
      assert.equal(await list.locator("video").count(), 0);
      await listHeader.scrollIntoViewIfNeeded();
      await screenshot("video-cards");
      await choose("file");
      await checkListToolbar("[data-personal-import]");
      await choose("trash");
      await checkListToolbar('[data-personal-trash="documents"]', false);
      assert.equal(await listHeader.locator("[data-personal-import]").isVisible(), false);
      await screenshot("trash-list");
      const documentTrash = list.locator("[data-personal-deleted-documents] .document-trash");
      await documentTrash.waitFor();
      assert.equal(await documentTrash.getByRole("heading").count(), 0);
      await list.locator('[data-personal-trash="files"]').click();
      await list.locator("[data-personal-files] .authoring-files").waitFor();

      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: "personal", document: id }));
      await page.locator("#documentReadTitle").waitFor();
      if (locale === "zh-TW") {
        await toolbar.locator('[data-doc-action="edit"]').click();
        const working = page.locator("#documentTitle");
        await checkToolbar(title);
        await screenshot("document-editing");
        const insert = toolbar.locator('[data-doc-action="insert-content"]');
        await insert.click();
        await page.locator(".document-insert-menu").waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".document-insert-menu").waitFor({ state: "hidden" });
        await working.fill("Draft retained when closing the reader");
        await close.click();
        await row.click();
        await toolbar.locator('[data-doc-action="edit"]').click();
        assert.equal(await working.inputValue(), "Draft retained when closing the reader");
        const save = toolbar.locator('[data-doc-action="save"]');
        await save.click();
        await page.waitForFunction(
          () =>
            document.querySelector("#documentSaveState")?.textContent ===
            globalThis.__pandaForceI18n.t("documents.versionSaved"),
        );
        await toolbar.locator('[data-doc-action="preview"]').click();
        await checkToolbar("Draft retained when closing the reader");
      }
      await close.click();
      await row.waitFor();
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        centralLists: true,
        compactCategoryHeader: true,
        worksDisplayModes: true,
        imageSlideAndVideoCovers: true,
        readerReturnsToList: true,
        compactAssetToolbar: true,
        assetOriginalMatches: true,
      });
      console.log(`${locale} ${width}: categories, inline readers, library focus and original download verified`);
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await app.dispose();
}
