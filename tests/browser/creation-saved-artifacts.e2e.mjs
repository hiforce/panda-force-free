import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { serverTranslator } from "../../src/server/i18n/messages.js";

const out = process.env.PANDA_SAVED_ARTIFACT_PROOF || ".artifacts/creation-saved-artifacts";
await mkdir(out, { recursive: true });
const records = [],
  image = await sharp({ create: { width: 1122, height: 1402, channels: 3, background: "#168c9b" } })
    .png()
    .toBuffer();
for (const kind of ["image", "video", "slides", "web", "document"]) {
  const app = await createAppFixture({
    startupTimeoutMs: 90000,
    applicationCreation: true,
    models: [
      {
        id: "gpt-fixture",
        model: "gpt-fixture",
        isDefault: true,
        displayName: "Fixture model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
    ...(kind === "image" || kind === "slides" ? { applicationImage: image.toString("base64") } : {}),
    ...(kind === "image" || kind === "document"
      ? {}
      : {
          applicationArtifact: {
            kind,
            arguments:
              kind === "video"
                ? {
                    slot: 1,
                    aspect: "portrait",
                    scenes: [
                      { duration: 3, heading: "Computer history", text: "From early computers to everyday devices" },
                    ],
                  }
                : kind === "slides"
                  ? {
                      slot: 1,
                      pages: [
                        {
                          layout: "picture",
                          title: "Computer history",
                          body: "From early computers to everyday devices",
                        },
                      ],
                    }
                  : {
                      slot: 1,
                      html: "<!doctype html><html><body><h1>Computer history</h1><p>A complete saved page.</p></body></html>",
                    },
          },
        }),
  });
  let saved;
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
          viewport: { width, height: 1040 },
          locale,
          isMobile: width < 768,
          hasTouch: width < 768,
          acceptDownloads: true,
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
          assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
          return response.json();
        };
        if (!saved) {
          const options = await api("/api/personal/document-creations/options"),
            id = randomUUID();
          await api("/api/personal/document-creations", {
            id,
            projectId: "personal",
            treeVersion: 0,
            parentId: null,
            locale: "en",
            prompt: "Create a finished computer history " + kind,
            outputType: kind,
            ...(kind === "image" || kind === "slides" ? { media: { kind: "image", source: "harness" } } : {}),
            profileId: options.defaultProfileId,
            selections: options.defaultWorkflow ? [options.defaultWorkflow] : [],
          });
          const answered = new Set();
          saved = await waitFor(async () => {
            const task = (await api("/api/personal/document-creations/detail?id=" + id)).task;
            if (task.failure) throw new Error(kind + " creation failed: " + JSON.stringify(task.failure));
            if (task.question && !answered.has(task.question.id)) {
              answered.add(task.question.id);
              await api("/api/personal/document-creations/answer", {
                id: task.question.id,
                answers: Object.fromEntries(
                  task.question.questions.map((q) => [q.id, { answers: [q.options?.[0]?.label || "General readers"] }]),
                ),
              });
            }
            return task.state === "succeeded" ? task : null;
          }, 60000);
          assert.equal(saved.artifact.kind, kind);
        }
        const page = await context.newPage(),
          errors = [],
          requests = [];
        page.setDefaultTimeout(30000);
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));
        let covers = 0;
        let mediaReads = 0;
        if (kind === "video")
          await page.route("**/api/creative-assets/view?*", async (route) => {
            if (++mediaReads === 1)
              return route.fulfill({ status: 503, contentType: "text/plain", body: "Fixture unavailable" });
            return route.continue();
          });
        if (kind === "image")
          await page.route("**/api/creative-assets/view?*variant=cover", async (route) => {
            covers++;
            if (covers === 1)
              return route.fulfill({
                status: 503,
                contentType: "application/json",
                body: '{"error":"fixture unavailable"}',
              });
            return route.continue();
          });
        await page.goto(app.base + "/creation/" + saved.id + "?creationScope=personal");
        const card = page.locator('.creation-task[data-state="succeeded"] .creation-artifact');
        await card.locator("h3").waitFor();
        assert.equal(await card.locator("h3").textContent(), saved.artifact.title);
        await page.locator("#prompt").fill("Keep this unsent follow-up");
        const switchLanguage = async () => {
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
            const action =
              kind === "document" ? card.locator('[data-creation-action="open"]') : card.locator("a[download]");
            assert.equal(
              await action.textContent(),
              serverTranslator(next)(kind === "document" ? "creation.openDocument" : "creative.assetDownload"),
            );
            assert.equal(await card.locator("h3").textContent(), saved.artifact.title);
            assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent follow-up");
          }
        };
        if (kind === "image") {
          await card.locator(".creation-artifact-error:visible").waitFor();
          await card.locator("[data-artifact-retry]").click();
          await waitFor(() =>
            card.locator("img").evaluate((img) => img.complete && !img.hidden && img.naturalWidth > 0),
          );
          assert.equal(covers, 2);
          const source = await card.locator("img").getAttribute("src");
          await switchLanguage();
          assert.equal(await card.locator("img").getAttribute("src"), source);
          assert.equal(covers, 2);
          assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent follow-up");
          assert.match(await card.locator("[data-artifact-dimensions]").textContent(), /1122.*1402/);
          assert.equal(
            await card.locator("img").evaluate((img) => img.naturalWidth <= 512 && img.naturalHeight <= 320),
            true,
          );
          await card.locator(".creation-artifact-preview").focus();
          await page.keyboard.press("Enter");
        } else if (kind === "video") {
          const player = card.locator("video");
          assert.equal(await player.getAttribute("preload"), "none");
          assert.equal(
            requests.some((r) => r.url.includes("/creative-assets/view")),
            false,
          );
          await player.evaluate((player) => {
            player.muted = true;
          });
          await card.locator("[data-artifact-play]").click();
          await card.locator("[data-artifact-media-error]:visible").waitFor();
          await card.locator("[data-artifact-media-retry]").click();
          await waitFor(() => player.evaluate((player) => player.currentTime > 0));
          await player.evaluate((player) => {
            player.pause();
            player.currentTime = 1;
          });
          assert.equal(await player.evaluate((player) => player.videoHeight), 1280);
          await switchLanguage();
          assert.equal(await player.evaluate((player) => player.currentTime), 1);
          await card.locator('[data-creation-action="open"]').click();
        } else if (kind === "document") {
          await switchLanguage();
          await page.screenshot({ path: `${out}/${kind}-${locale}-${width}.png` });
          await card.locator('[data-creation-action="open"]').click();
          await page.waitForURL((url) => url.pathname === "/documents");
        } else {
          await switchLanguage();
          await card.locator('[data-creation-action="open"]').click();
        }
        if (kind !== "document") {
          await page.waitForURL((url) => url.searchParams.get("asset") === saved.artifact.assetId);
          const dialog = page.locator("[data-personal-reader]:visible");
          await dialog.locator("a[download]").first().waitFor();
          if (kind === "image")
            await waitFor(() =>
              dialog
                .locator("img[data-asset-native]")
                .evaluate((img) => img.complete && img.naturalWidth === 1122 && img.naturalHeight === 1402),
            );
          if (kind === "video")
            await waitFor(() =>
              dialog
                .locator("video[data-asset-native]")
                .evaluate((video) => video.readyState > 0 && video.duration === 3),
            );
          if (kind === "web") assert.equal(await dialog.locator("iframe[sandbox]").count(), 1);
          const download = page.waitForEvent("download");
          await dialog.locator("a[download]").first().click();
          const bytes = await readFile(await (await download).path());
          if (kind === "image") assert.deepEqual(bytes, image);
          if (kind === "video") assert(bytes.includes(Buffer.from("ftyp")));
          if (kind === "slides") assert.equal(bytes.subarray(0, 2).toString(), "PK");
          if (kind === "web") assert(bytes.includes(Buffer.from("A complete saved page.")));
          await page.goBack();
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent follow-up");
          await page.screenshot({ path: `${out}/${kind}-${locale}-${width}.png` });
          if (kind === "video") {
            await page.goto(app.base + "/workspace");
            assert.equal(await page.locator(".creation-artifact-media").count(), 0);
          }
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        assert(
          requests
            .filter((r) => r.url.includes("/api/creative-assets"))
            .every((r) => new URL(r.url).origin === app.base),
        );
        records.push({
          kind,
          locale,
          width,
          nativeFile: true,
          receiptTitle: true,
          protectedViewer: true,
          exactDownload: kind !== "document",
          draftPreserved: kind !== "document",
          coverRecovery: kind === "image",
          inlinePlayback: kind === "video",
          overflow: false,
          liveLanguageSwitching: true,
          errors: 0,
        });
        console.log("Saved artifact verified", kind, locale, width);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await app.dispose();
  }
}
await writeFile(
  out + "/checks.json",
  JSON.stringify(
    {
      passed: true,
      records,
      inference: "Controlled CLI fixture; prior real-model generation baseline reused without new inference",
    },
    null,
    2,
  ),
);
