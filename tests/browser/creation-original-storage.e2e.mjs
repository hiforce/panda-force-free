import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { objectStorageFixture } from "../support/object-storage-fixture.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const s3 = await objectStorageFixture();
if (!s3) throw new Error("A disposable S3 fixture is required");
const out = process.env.PANDA_CREATION_STORAGE_PROOF || ".artifacts/creation-original-storage";
await mkdir(out, { recursive: true });
const proof = [];
try {
  for (const [kind, engine, width, locale] of [
    ["image", chromium, 1440, "en"],
    ["video", webkit, 390, "zh-TW"],
  ]) {
    const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#168c9b" } })
        .png()
        .toBuffer(),
      app = await createAppFixture({
        applicationCreation: true,
        startupTimeoutMs: 90000,
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
        ...(kind === "image"
          ? { applicationImage: image.toString("base64") }
          : {
              applicationArtifact: {
                kind: "video",
                arguments: {
                  slot: 1,
                  aspect: "portrait",
                  scenes: [
                    { duration: 3, heading: "电子管计算机", text: "计算机走出实验室" },
                    { duration: 3, heading: "个人电脑与云计算", text: "计算能力走进日常生活" },
                  ],
                },
              },
            }),
      });
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
        hasTouch: width < 700,
        isMobile: width < 700,
        acceptDownloads: true,
      });
      await app.signIn(context);
      await context.addInitScript((value) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-locale", value);
      }, locale);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
        assert(response.ok(), await response.text());
        return response.json();
      };
      const bucket = "panda-created-" + randomUUID(),
        created = await s3.request("PUT", "/" + bucket);
      assert.equal(created.status, 200);
      await created.body?.cancel();
      const config = await api("/api/system/storage");
      await api("/api/system/storage", {
        action: "configure",
        revision: config.revision,
        operationId: randomUUID(),
        mode: "s3",
        kinds: ["image", "video"],
        profile: {
          ...s3.connection(bucket),
          label: "Created originals",
          prefix: "generated",
          credentials: s3.credentials,
        },
      });
      const page = await context.newPage(),
        errors = [],
        origins = new Set();
      page.setDefaultTimeout(30000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/creative-assets"))
          origins.add(new URL(request.url()).origin);
      });
      await page.goto(app.base + "/create");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page
        .locator(
          `[data-discovery-grid] [data-skill-id="${kind === "image" ? "science-illustration" : "short-film-storyboard"}"]`,
        )
        .click();
      await page.locator("[data-creation-output]").selectOption(kind);
      if (kind === "image") {
        const { runtime } = await api("/api/model-catalog?scope=creation&runtimeId=codex");
        assert.equal(runtime.protocol, "codex-app-server/model-list");
        assert.equal(runtime.creationCapabilities.nativeImageStatus, "available");
        const options = await api("/api/personal/document-creations/options");
        const missingSource = await context.request.post(app.base + "/api/personal/document-creations", {
          data: {
            id: randomUUID(),
            projectId: "personal",
            treeVersion: 0,
            parentId: null,
            profileId: options.defaultProfileId,
            runtimeId: "codex",
            model: "gpt-fixture",
            locale,
            prompt: "Generate a history illustration",
            selections: [],
            outputType: "image",
          },
          headers: { Origin: app.base },
        });
        assert.equal(missingSource.status(), 409);
        assert.equal((await missingSource.json()).code, "runtimeSelectionUnavailable");
        const source = page.locator("[data-media-executor]");
        await source.locator('option[value="harness"]').waitFor({ state: "attached" });
        await source.selectOption("harness");
      }
      await page
        .locator("#prompt")
        .fill(
          kind === "image"
            ? "请直接生成计算机发展历史知识插画成品。"
            : "请直接生成介绍计算机发展历史的无配音动态图文视频成品。",
        );
      await page.locator("#sendButton").click();
      await page.waitForURL((url) => url.pathname.startsWith("/creation/"));
      const id = new URL(page.url()).pathname.split("/").at(-1);
      const task = await waitFor(async () => {
        const value = (await api("/api/personal/document-creations/detail?id=" + id)).task;
        if (value.failure) throw new Error("Creation failed before a saved original: " + JSON.stringify(value.failure));
        return value.state === "succeeded" ? value : null;
      }, 45000);
      assert.equal(task.artifact.kind, kind);
      assert.equal("documentId" in task.artifact, false);
      const detail = await api(
        "/api/creative-assets/item?" + new URLSearchParams({ project: "personal", id: task.artifact.assetId }),
      );
      assert.equal(detail.asset.originalStore, "object");
      assert.equal(detail.asset.version, task.artifact.version);
      if (kind === "video")
        assert(detail.asset.resources.length > 0, "Composition source must be retained with the video");
      await page.locator("[data-creation-open]").click();
      await page.waitForURL((url) => url.searchParams.get("asset") === task.artifact.assetId);
      const viewer = page.locator("[data-personal-reader]:visible");
      const originalLink = viewer.locator("a[download]").first();
      await originalLink.waitFor();
      if (kind === "image")
        await waitFor(() =>
          viewer
            .locator("img[data-asset-native]")
            .evaluate((element) => element.complete && element.naturalWidth === 256),
        );
      else
        await waitFor(() =>
          viewer
            .locator("video[data-asset-native]")
            .evaluate((element) => element.readyState > 0 && element.videoHeight === 1280 && element.duration === 6),
        );
      const content = await context.request.get(app.base + (await originalLink.getAttribute("href")));
      assert(content.ok());
      const original = await content.body();
      if (kind === "image") assert.deepEqual(original, image);
      else {
        assert(original.includes(Buffer.from("ftyp")));
        assert(original.length > 10000);
      }
      const download = page.waitForEvent("download");
      await originalLink.click();
      assert.deepEqual(await readFile(await (await download).path()), original);
      await page.screenshot({ path: `${out}/${kind}-${width}.png` });
      assert.deepEqual([...origins], [app.base]);
      assert.deepEqual(errors, []);
      proof.push({
        kind,
        locale,
        width,
        actualTaskLedger: true,
        nativeAdapterAndOriginalWriter: true,
        originalSavedInS3: true,
        originalPrivateApplicationRead: true,
        exactDownload: true,
        retainedComposition: kind === "video",
        documentIdentityAbsent: true,
        engine:
          "Controlled CLI fixture; test PNG validation or actual FFmpeg video rendering; prior real-model baseline reused without new inference",
      });
    } finally {
      await browser.close();
      await app.dispose();
    }
  }
  await writeFile(out + "/checks.json", JSON.stringify({ passed: true, proof }, null, 2));
  console.log(JSON.stringify({ cases: proof.length, saved: out + "/checks.json" }));
} finally {
  await s3.close();
}
