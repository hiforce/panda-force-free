import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { officeFixture } from "../support/office-presentation.js";
import { textPdf } from "../support/material-text.js";

const fixture = await createAppFixture({ startupTimeoutMs: 90000 });
const artifacts = process.env.PANDA_PROJECT_FILES_PROOF || ".artifacts/project-document-files";
await mkdir(artifacts, { recursive: true });
const files = [
  {
    kind: "image",
    name: "history.png",
    bytes: await sharp({ create: { width: 96, height: 64, channels: 3, background: "#168c9b" } })
      .png()
      .toBuffer(),
  },
  {
    kind: "video",
    name: "history.mp4",
    bytes: await readFile(new URL("../support/media/preview.mp4", import.meta.url)),
  },
  { kind: "file", name: "notes.txt", bytes: Buffer.from("A preserved original 中文 <script>neverExecute()</script>") },
  { kind: "file", name: "report.pdf", bytes: Buffer.from(textPdf({ text: "A portable original." })) },
  { kind: "file", name: "archive.bin", bytes: Buffer.from([1, 0, 255, 7, 13]) },
  {
    kind: "web",
    name: "history.html",
    bytes: Buffer.from(
      '<!doctype html><html><body><h1>Computer history</h1><script>throw new Error("must not run")</script></body></html>',
    ),
  },
  { kind: "slides", name: "history.pptx", bytes: Buffer.from(officeFixture().bytes()) },
];
const proof = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    if (process.env.PANDA_PROJECT_FILES_LOCALE && process.env.PANDA_PROJECT_FILES_LOCALE !== locale) continue;
    const browser = await engine.launch();
    let releaseList = () => {},
      releaseModule = () => {};
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
        isMobile: width < 700,
        hasTouch: width < 700,
        acceptDownloads: true,
      });
      await fixture.signIn(context);
      await context.addInitScript((value) => {
        if (location.protocol.startsWith("http")) {
          localStorage.setItem("panda-force-locale", value);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(fixture.base + path)
            : await context.request.post(fixture.base + path, { data, headers: { Origin: fixture.base } });
        assert(response.ok(), await response.text());
        return response.json();
      };
      const catalog = await api("/api/projects"),
        code = "mixed-" + locale.toLowerCase(),
        created = await api("/api/projects", { name: "Project originals " + locale, code, revision: catalog.revision }),
        project = created.projects.find((value) => value.code === code),
        saved = [];
      for (const input of files) {
        const params = new URLSearchParams({
          project: project.id,
          id: "c-" + randomUUID(),
          operationId: randomUUID(),
          kind: input.kind,
          name: input.name,
          title: input.name,
          locale: "en",
        });
        const response = await context.request.post(fixture.base + "/api/creative-assets/import?" + params, {
          data: input.bytes,
          headers: { "content-type": "application/octet-stream", Origin: fixture.base },
        });
        assert.equal(response.status(), 201, await response.text());
        saved.push((await response.json()).asset);
      }
      const page = await context.newPage(),
        errors = [],
        listGate = new Promise((resolve) => {
          releaseList = resolve;
        });
      let firstList = true,
        listStarted = false;
      page.setDefaultTimeout(25000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/creative-assets?*", async (route) => {
        if (!firstList) return route.continue();
        firstList = false;
        listStarted = true;
        await listGate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { messageId: "documents.unavailable" } }),
        });
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await waitFor(() => listStarted);
      await page.locator('[data-authoring-action="new"]').click();
      const surface = page.locator('.document-rich-content[contenteditable="true"]');
      await surface.waitFor();
      await page.locator("#documentTitle").fill("Uncheckpointed working document");
      await surface.fill("Working text stays intact while viewing another file.");
      const documentId = new URL(page.url()).searchParams.get("document");
      assert(documentId);
      releaseList();
      const directory = async () => {
        if (width < 700 && !(await page.locator("#authoringDirectory").isVisible())) {
          if (
            !(await page
              .locator(
                '[data-authoring-action="directory"]:visible, [data-authoring-action="reader-directory"]:visible',
              )
              .count())
          )
            await page.locator(".document-editor-more > summary").click();
          await page
            .locator('[data-authoring-action="directory"]:visible, [data-authoring-action="reader-directory"]:visible')
            .first()
            .click();
        }
      };
      await directory();
      await page.locator('.authoring-files [data-file-action="refresh"]').click();
      await page.locator('.authoring-files [data-file-id="' + saved[0].id + '"]').waitFor();
      assert.equal(await page.locator("#documentTree > .authoring-files").count(), 1);
      await page.locator("#documentSearch").fill("notes.txt");
      await waitFor(async () => (await page.locator('.authoring-files [data-file-action="open"]').count()) === 1);
      await page.locator('[data-authoring-action="refresh-tree"]').click();
      assert.equal(await page.locator("#documentSearch").inputValue(), "notes.txt");
      await page.locator("#documentSearch").fill("");
      await waitFor(
        async () => (await page.locator('.authoring-files [data-file-action="open"]').count()) === files.length,
      );
      if (locale === "en" || locale === "zh-CN") {
        const moduleGate = new Promise((resolve) => {
          releaseModule = resolve;
        });
        let started = false;
        await page.route("**/creative-assets.bundle.js*", async (route) => {
          started = true;
          await moduleGate;
          await route.continue();
        });
        await page.locator('[data-file-id="' + saved[0].id + '"]').click();
        await waitFor(() => started);
        await page.locator('#authoringFileDialog[open] [role="status"]').waitFor();
        await page.keyboard.press("Escape");
        await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
        releaseModule();
        await page.waitForTimeout(350);
        assert.equal(await page.locator("#authoringFileDialog").isVisible(), false);
        await page.unroute("**/creative-assets.bundle.js*");
      }
      for (let at = 0; at < files.length; at++) {
        await directory();
        const trigger = page.locator('[data-file-id="' + saved[at].id + '"]');
        await trigger.click();
        const dialog = page.locator("#authoringFileDialog[open]");
        await dialog.locator("a[download]").first().waitFor();
        if (width < 700)
          assert.equal(
            await page.locator("#authoringDirectory").isVisible(),
            false,
            JSON.stringify(
              await page.evaluate(() => ({
                width: innerWidth,
                mobile: matchMedia("(max-width:700px)").matches,
                classes: document.querySelector(".project-document-authoring").className,
                display: getComputedStyle(document.querySelector("#authoringDirectory")).display,
              })),
            ),
          );
        if (files[at].kind === "image")
          await waitFor(() =>
            dialog.locator("img[data-asset-native]").evaluate((image) => image.complete && image.naturalWidth === 96),
          );
        if (files[at].kind === "video")
          await waitFor(() =>
            dialog.locator("video[data-asset-native]").evaluate((video) => video.readyState > 0 && video.duration > 0),
          );
        if (files[at].kind === "web") {
          const frame = dialog.locator("[data-asset-frame]").contentFrame();
          await frame.locator("h1").waitFor();
          assert.equal(await frame.locator("script").count(), 0);
        }
        if (files[at].name.endsWith("txt")) assert.match(await dialog.locator("pre").innerText(), /<script>/);
        if (files[at].kind === "slides") assert((await dialog.locator(".creative-asset-sections section").count()) > 0);
        const event = page.waitForEvent("download");
        await dialog.locator("a[download]").first().click();
        assert.deepEqual(await readFile(await (await event).path()), files[at].bytes);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (at === 0 || files[at].kind === "web")
          await page.screenshot({ path: artifacts + "/file-" + files[at].kind + "-" + locale + "-" + width + ".png" });
        await dialog.locator("[data-doc-close]").click();
        assert.equal(await page.locator("#documentTitle").inputValue(), "Uncheckpointed working document");
        assert.match(await surface.innerText(), /Working text stays intact/);
        assert.equal(new URL(page.url()).searchParams.get("document"), documentId);
        if (width >= 700) assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
      }
      await directory();
      await page.locator('[data-file-id="' + saved[0].id + '"]').click();
      await page.locator("#authoringFileDialog [data-asset-trash]").click();
      await page.locator('#authoringFileDialog [type="submit"]').click();
      await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-file-action="trash"]').click();
      await page.locator('[data-file-id="' + saved[0].id + '"]').click();
      await page.locator('#authoringFileDialog [type="submit"]').click();
      await page.locator("#authoringFileDialog").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-file-action="saved"]').click();
      await page.locator('[data-file-id="' + saved[0].id + '"]').waitFor();
      await page.screenshot({ path: artifacts + "/directory-" + locale + "-" + width + ".png" });
      assert.deepEqual(errors, []);
      proof.push({
        locale,
        width,
        kinds: files.map((file) => file.name),
        actualAuthenticatedImportAndRead: true,
        optionalMetadata503DoesNotBlockDocument: true,
        searchPreservedAcrossRefresh: true,
        exactDownloads: true,
        draftAndLocationPreserved: true,
        trashRestore: true,
        lazyCancel: width === 1440,
        sameDirectoryScrollRegion: true,
        overflow: false,
        errors,
      });
      await context.close();
    } finally {
      releaseList();
      releaseModule();
      await browser.close();
    }
  }
  await writeFile(artifacts + "/checks.json", JSON.stringify({ passed: true, proof }, null, 2));
  console.log(
    `Project documents: ${proof.length} locale cases, seven original types, draft preservation, metadata retry, lazy cancellation and trash restore passed.`,
  );
} finally {
  await fixture.dispose();
}
