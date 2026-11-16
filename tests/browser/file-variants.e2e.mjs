import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";
import { chromium, webkit } from "playwright";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture();
await mkdir(".artifacts/file-variants-browser", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width === 390 ? "dark" : "light",
      });
      await app.signIn(context);
      const api = async (path, data, method = data === undefined ? "get" : "post") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const current = await api("/api/projects"),
        code = "variants-" + width,
        created = await api("/api/projects", { name: "Channel formats", code, revision: current.revision }),
        project = created.projects.find((p) => p.code === code),
        catalog = new ProjectCatalog(join(app.dir, "panda-state/data/projects.sqlite"));
      try {
        assert.equal(new ProjectDocumentStorage(catalog.db).files(project.id), true);
      } finally {
        catalog.close();
      }
      const tree = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: 0,
          title: "One saved original",
          locale: "en",
          parentId: null,
        }),
        id = tree.operation.documentId,
        query = new URLSearchParams({ project: project.id, id }),
        opened = await api("/api/project-documents/editor?" + query),
        image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#498ea3" } })
          .png()
          .toBuffer();
      const uploaded = await context.request.post(
        app.base +
          "/api/project-documents/assets?" +
          new URLSearchParams({
            project: project.id,
            document: id,
            name: "Example.png",
            operationId: crypto.randomUUID(),
          }),
        { headers: { "content-type": "application/octet-stream" }, data: image },
      );
      assert.ok(uploaded.ok());
      const asset = (await uploaded.json()).asset;
      const body = {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "One saved source. Many formats.", marks: [{ type: "bold" }] }],
            },
            { type: "codeBlock", content: [{ type: "text", text: "const exact = 1;" }] },
            {
              type: "image",
              attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "An owned illustration" },
            },
          ],
        },
      };
      const draft = await api(
        "/api/project-documents/editor?" + query,
        {
          operationId: crypto.randomUUID(),
          version: opened.draft.version,
          baseRevisionId: opened.draft.baseRevisionId,
          working: { ...opened.working, body },
        },
        "put",
      );
      const saved = await api("/api/project-documents/checkpoints?" + query, {
        operationId: crypto.randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.receipt.version,
      });
      const page = await context.newPage(),
        errors = [],
        legacy = [],
        social = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          [
            "/api/document-assets/content",
            "/api/documents/detail",
            "/api/document-spaces",
            "/api/document-placements",
          ].includes(path)
        )
          legacy.push(path);
        if (path.startsWith("/api/social-publications"))
          social.push({ path, method: request.method(), project: new URL(request.url()).searchParams.get("project") });
      });
      const manager = page.locator("#documentPublicationDialog"),
        channels = page.locator("#publishingDialog");
      async function openChannels() {
        await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.locator("#documentReadTitle").waitFor();
        await page.locator('[data-doc-action="publishing"]').click();
        await manager.locator('[data-placement-action="channels"]:not([disabled])').click();
        await channels.locator("#publicationTemplate option").first().waitFor({ state: "attached" });
      }
      await openChannels();
      for (const format of ["html", "x-post", "x-article"]) {
        if (width === 390 && (await channels.locator(".publishing-settings").getAttribute("data-collapsed")) === "true")
          await channels.locator('[data-pub-action="settings"]').click();
        await channels.locator("#publicationFormat").selectOption(format);
        await channels.locator('[data-pub-action="prepare"]:not([disabled])').click();
        await channels.locator("#publicationHistory option").nth(1).waitFor({ state: "attached" });
        await channels.locator('[data-pub-action="prepare"]:not([disabled])').waitFor({ state: "attached" });
        const preview = channels.locator("#publicationPreview");
        assert.ok((await preview.innerText()).includes("One saved source"));
        const img = preview.locator("img").first();
        await img.scrollIntoViewIfNeeded();
        assert.ok((await img.getAttribute("src")).includes("/api/project-documents/assets/content?"));
        await img.evaluate((el) => el.decode());
        assert.ok(await img.evaluate((el) => el.naturalWidth > 0));
        assert.equal(await channels.locator('[data-pub-action="publish"]').isHidden(), format === "html");
        for (const issue of await channels.locator("[data-issue]").all()) await issue.check();
        await channels.locator('[data-pub-action="review"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-pub-action="review"]').disabled &&
            !document.querySelector('[data-pub-action="prepare"]').disabled,
        );
      }
      const history = await api(
        "/api/publication-variants?" + new URLSearchParams({ project: project.id, document: id }),
      );
      assert.equal(history.variants.length, 3);
      const selected = await channels.locator("#publicationHistory").inputValue();
      const detail = await api("/api/publication-variants/detail?id=" + selected);
      assert.equal(detail.variant.source.projectId, project.id);
      assert.equal(detail.variant.source.revisionId, saved.detail.revision.id);
      assert.match(detail.variant.source.commit, /^[a-f0-9]{40}$/);
      const download = page.waitForEvent("download");
      await channels.locator('[data-pub-action="export-bundle"]').click();
      const downloaded = await download;
      assert.match(downloaded.suggestedFilename(), /\.zip$/);
      const bundle = unzipSync(new Uint8Array(await readFile(await downloaded.path())));
      const manifest = JSON.parse(strFromU8(bundle["manifest.json"]));
      assert.equal(manifest.source.projectId, project.id);
      assert.equal(manifest.format, "x-article");
      assert.deepEqual(bundle["assets/" + asset.id + "/Example.png"], new Uint8Array(image));
      const canonical = await api("/api/project-documents/source?" + query);
      assert.deepEqual(JSON.parse(strFromU8(bundle["source.rich.json"])), canonical.revision.body);
      assert.equal(canonical.document.revision, 2);
      await openChannels();
      await channels.locator("#publicationHistory").selectOption(selected);
      await channels.locator('[data-pub-action="review"]:disabled').waitFor();
      assert.equal(await channels.locator('[data-pub-action="publish"]').isVisible(), true);
      assert.doesNotMatch(await channels.innerText(), /publishing\.[a-zA-Z]+/);
      assert.equal(await channels.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      await page.screenshot({ path: ".artifacts/file-variants-browser/" + width + ".png" });
      assert.deepEqual(errors, []);
      assert.deepEqual(legacy, []);
      await channels.locator('[data-pub-action="publish"]').click();
      const socialDialog = page.locator("#socialPublicationDialog");
      await socialDialog.locator("#socialNoAccounts").waitFor();
      await page.waitForFunction(() => document.querySelector("#socialNotice")?.hidden === true);
      assert.equal(await socialDialog.locator('[data-social-action="prepare"]').isDisabled(), true);
      assert.ok(social.some((request) => request.path === "/api/social-publications/context"));
      assert.ok(
        social.some((request) => request.path === "/api/social-publications" && request.project === project.id),
      );
      assert.ok(social.every((request) => request.method === "GET"));
      await socialDialog.locator('[data-social-action="close"]').click();
      const publicationContext = await api("/api/social-publications/context?variant=" + selected);
      // The history response is a UI contract fixture; source and owned image requests remain real.
      const record = {
        plan: {
          id: crypto.randomUUID(),
          kind: "x-article-draft",
          ...publicationContext,
          connectionId: crypto.randomUUID(),
          fingerprint: "a".repeat(64),
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          payload: {
            source: { ...detail.variant.source, variantId: selected, variantDigest: detail.digest },
            target: { username: "isolated" },
            content: {
              format: "x-article",
              draft: {
                title: detail.variant.title,
                content_state: { blocks: [{ key: "first", type: "unstyled", text: detail.variant.text }] },
              },
            },
            media: detail.variant.images.map((image, index) => ({
              ...asset,
              ...image,
              assetId: asset.id,
              key: "m" + (index + 1),
            })),
          },
        },
        phase: "prepared",
        updatedAt: Date.now(),
        receipt: null,
        error: null,
        steps: [],
        confirmations: [],
        observations: [],
      };
      await page.route("**/api/social-publications?*", (route) => {
        const url = new URL(route.request().url());
        assert.equal(route.request().method(), "GET");
        assert.equal(url.searchParams.get("project"), project.id);
        assert.equal(url.searchParams.get("space"), publicationContext.spaceId);
        return route.fulfill({ json: { publications: [record] } });
      });
      await channels.locator('[data-pub-action="publish"]').click();
      const socialImage = socialDialog.locator(".social-media img");
      await socialImage.scrollIntoViewIfNeeded();
      await socialImage.evaluate((el) => el.decode());
      assert.ok((await socialImage.getAttribute("src")).includes("/api/project-documents/assets/content?"));
      assert.equal(await socialImage.evaluate((el) => el.naturalWidth), 2);
      const submit = socialDialog.locator('[data-social-action="submit"]');
      assert.equal(await submit.isDisabled(), true);
      await socialDialog.locator("#socialAcceptCosts").check();
      assert.equal(await submit.isDisabled(), true);
      await socialDialog.locator("#socialAcceptEligibility").check();
      assert.equal(await submit.isEnabled(), true);
      assert.ok(social.every((request) => request.method === "GET"));
      assert.deepEqual(legacy, []);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          width,
          locale,
          scopedOriginal: true,
          postAndArticle: true,
          ownedImage: true,
          review: true,
          bundle: true,
          canonicalPreserved: true,
          history: true,
          legacyDenied: true,
          scopedSocialImage: true,
          independentConsents: true,
        }),
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
