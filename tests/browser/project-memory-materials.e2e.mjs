import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createEncryptionKey } from "../../src/client/encryption-keys/key-store.ts";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.ts";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

const out = process.env.PANDA_FORCE_MEMORY_MATERIAL_PROOF || ".artifacts/project-memory-materials";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
let target;
let s3;
const phrase = "test key for material exports";
try {
  const settings = await createEncryptionKey("Material fixture", phrase);
  const raster = await sharp(randomBytes(1536 * 1536 * 3), {
    raw: { width: 1536, height: 1536, channels: 3 },
  })
    .png()
    .toBuffer();
  const diagram = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#245852" } })
    .png()
    .toBuffer();
  const { bytes: slides } = await renderCreationSlides(
    [
      { layout: "content", title: "Site plan", body: "A two percent grade." },
      { layout: "picture", title: "Ramp detail", body: "Verify the section.", imageHandle: "f".repeat(64) },
    ],
    async () => diagram,
  );
  const markdown = "# Building standards\n\nReview a 2 percent slope.\n";
  const format = (code) => "/project?" + new URLSearchParams({ id: code, tab: "memory", memoryView: "records" });
  const open = async (browser, fixture, width, locale) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 700,
      hasTouch: width < 700,
    });
    await fixture.signIn(context);
    await context.addInitScript((language) => {
      localStorage.setItem("panda-force-locale", language);
      localStorage.setItem("panda-force-theme", "aurora");
    }, locale);
    const request = (path, data, method = data === undefined ? "GET" : "POST") =>
      context.request.fetch(fixture.base + path, { method, data, headers: { Origin: fixture.base } });
    const api = async (...args) => {
      const response = await request(...args);
      assert(
        response.ok(),
        args[0] +
          " " +
          response.status() +
          " " +
          (response.ok() ? "" : (await response.text()) + "\n" + fixture.logs()),
      );
      return response.json();
    };
    const project = async (code) => {
      const current = await api("/api/projects");
      const next = await api("/api/projects", {
        code,
        name: "Building plans",
        revision: current.revision,
        operationId: randomUUID(),
      });
      return next.projects.find((item) => item.code === code);
    };
    const page = await context.newPage();
    const goto = async (path) => {
      await page.goto(fixture.base + path);
      await page.locator(".project-memory-view").waitFor();
      await page.evaluate((backup) => {
        localStorage.setItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey, JSON.stringify([backup]));
      }, settings);
    };
    return { context, request, api, project, page, goto };
  };
  const browser = await chromium.launch();
  let archiveFile;
  let source;
  try {
    const client = await open(browser, app, 1366, "en");
    source = await client.project("architecture-source");
    const tree = await client.api("/api/project-document-tree/documents", {
      id: randomUUID(),
      projectId: source.id,
      treeVersion: 0,
      title: "Building standards",
      locale: "zh-CN",
      parentId: null,
    });
    const query = new URLSearchParams({ project: source.id, id: tree.operation.documentId });
    const documentImageUpload = await client.context.request.post(
      app.base +
        "/api/project-documents/assets?" +
        new URLSearchParams({
          project: source.id,
          document: tree.operation.documentId,
          operationId: randomUUID(),
          name: "sketch.png",
        }),
      { data: diagram, headers: { Origin: app.base, "content-type": "application/octet-stream" } },
    );
    assert.equal(documentImageUpload.status(), 201, await documentImageUpload.text());
    const { asset: embedded } = await documentImageUpload.json();
    const opened = await client.api("/api/project-documents/editor?" + query);
    const body = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Building standards" }] },
          { type: "paragraph", content: [{ type: "text", text: markdown.trim() }] },
          {
            type: "image",
            attrs: { src: "/api/document-assets/content?id=" + embedded.id, alt: "Site sketch", width: 64, height: 48 },
          },
        ],
      },
    };
    const draft = await client.api(
      "/api/project-documents/editor?" + query,
      {
        operationId: randomUUID(),
        version: opened.draft.version,
        baseRevisionId: opened.draft.baseRevisionId,
        working: { ...opened.working, body },
      },
      "PUT",
    );
    await client.api("/api/project-documents/checkpoints?" + query, {
      operationId: randomUUID(),
      revisionId: opened.saved.revision.id,
      draftVersion: draft.receipt.version,
    });
    const saved = await client.api("/api/project-documents/source?" + query);
    assert.match(saved.revision.content, /2 percent/);
    const expectedDoc = Buffer.from(saved.revision.content);
    const upload = async (name, title, kind, bytes) => {
      const query = new URLSearchParams({
        id: "c-" + randomUUID(),
        operationId: randomUUID(),
        project: source.id,
        name,
        title,
        kind,
        locale: "en",
      });
      const result = await client.context.request.post(app.base + "/api/creative-assets/import?" + query, {
        data: bytes,
        headers: { Origin: app.base, "content-type": "application/octet-stream" },
      });
      assert(result.ok(), "Asset import " + name + " " + result.status());
      return (await result.json()).asset;
    };
    const plan = await upload("site-plan.png", "Site plan", "image", raster);
    await upload("design-review.pptx", "Design review", "slides", slides);
    await client.goto(format(source.id));
    const panel = client.page.locator(".memory-package-dialog");
    await client.page.locator("[data-memory-packages-export]").click();
    const picker = panel.locator("[data-package-material-picker]");
    await picker.locator("summary").click();
    await picker.getByText("Site plan", { exact: true }).click();
    await picker.getByText("Design review", { exact: true }).click();
    await picker.locator("select").selectOption("document");
    await picker.getByText("Building standards", { exact: true }).click();
    await client.page.screenshot({ path: join(out, "package-material-export-pc.png") });
    const received = client.page.waitForEvent("download");
    await panel.locator("[data-memory-package-export]").click();
    archiveFile = join(app.dir, "architecture.pmf");
    await (await received).saveAs(archiveFile);
    const downloaded = Buffer.from(await Bun.file(archiveFile).arrayBuffer());
    assert.equal(downloaded.subarray(0, 4).toString("hex"), "504d4602");
    assert(downloaded.length > 5 * 1024 * 1024);
    await panel.locator("[data-memory-package-close]").click();
    const restored = await client.project("architecture-local");
    await verify(client, restored, false, "pc", [raster, slides, expectedDoc, embedded]);

    // A package exported from this installation cannot import a source version that has since changed.
    const replacement = Buffer.from(
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    const changed = await client.context.request.post(
      app.base +
        "/api/creative-assets/import?" +
        new URLSearchParams({
          id: plan.id,
          operationId: randomUUID(),
          project: source.id,
          name: "site-plan.png",
          title: "Site plan",
          kind: "image",
          locale: "en",
          version: plan.version,
        }),
      { data: replacement, headers: { Origin: app.base, "content-type": "application/octet-stream" } },
    );
    assert(changed.ok());
    const denied = await client.project("architecture-stale");
    await client.goto(format(denied.id));
    await client.page.locator("[data-memory-packages-import]").click();
    await panel.locator("[data-memory-package-file]").setInputFiles(archiveFile);
    await panel.locator("[data-memory-package-unlock] input").fill(phrase);
    const failing = client.page.waitForResponse((response) => response.url().endsWith("/memory-import-preview"));
    await panel.locator("[data-memory-package-review]").click();
    assert.equal((await failing).status(), 409);
    assert(!(await panel.locator('button[type="submit"]').isVisible()));

    s3 = await objectStorageFixture();
    if (!s3) throw new Error("An isolated S3 fixture is required for the portable H5 flow");
    target = await createAppFixture({ startupTimeoutMs: 60000 });
    const mobile = await webkit.launch();
    try {
      for (const [width, locale] of [
        [390, "zh-CN"],
        [390, "zh-HK"],
        [320, "zh-TW"],
      ]) {
        const h5 = await open(mobile, target, width, locale);
        const bucket = "panda-material-" + randomUUID();
        assert.equal((await s3.request("PUT", "/" + bucket)).status, 200);
        const storage = await h5.api("/api/system/storage");
        await h5.api("/api/system/storage", {
          revision: storage.revision,
          operationId: randomUUID(),
          action: "configure",
          mode: "s3",
          kinds: ["project-memory-package"],
          profile: { ...s3.connection(bucket), label: "Private material", prefix: "test", credentials: s3.credentials },
        });
        const project = await h5.project("architecture-" + locale.toLowerCase());
        await verify(h5, project, true, locale, [raster, slides, expectedDoc, embedded]);
        await h5.context.close();
      }
    } finally {
      await mobile.close();
    }
  } finally {
    await browser.close();
  }
  async function verify(client, project, remote, tag, expected) {
    const path = "/api/projects/" + project.id + "/";
    await client.goto(format(project.id));
    const entry = client.page.locator("[data-memory-packages-import]");
    await entry.click();
    const panel = client.page.locator(".memory-package-dialog");
    await panel.locator("[data-memory-package-file]").setInputFiles(archiveFile);
    if (remote) {
      await panel.locator("[data-memory-package-review]").click();
      await waitFor(
        async () => (await client.api(path + "memory-upload")).transfers.some((item) => item.state === "awaiting-key"),
        60000,
      );
      await panel.locator("[data-memory-package-close]").click();
      await entry.click();
      await panel.locator('[data-package-action="choose"]').click();
    }
    await panel.locator("[data-memory-package-unlock] input").fill(phrase);
    await panel.locator("[data-memory-package-review]").click();
    await panel.locator("[data-memory-package-preview] .memory-package-materials").getByText("site-plan.png").waitFor();
    const submit = panel.locator('button[type="submit"]');
    await submit.waitFor();
    assert(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await client.page.screenshot({ path: join(out, "package-material-review-" + tag + ".png") });
    await submit.click();
    await panel.locator("[data-package-withdraw]").waitFor();
    const links = await panel
      .locator("[data-memory-package-history] .memory-package-materials a")
      .evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, href: node.getAttribute("href") })));
    assert.equal(links.length, 4);
    for (const [index, match] of ["site-plan.png", "design-review.pptx", "Building standards.md"].entries()) {
      const link = links.find(({ text }) => text.endsWith(match));
      assert(link);
      const download = await client.request(link.href);
      assert.equal(download.status(), 200, match + ": " + (download.ok() ? "" : await download.text()));
      assert.match(download.headers()["cache-control"] ?? "", /no-store/u);
      assert.deepEqual(await download.body(), expected[index]);
    }
    const history = panel.locator("[data-memory-package-history]");
    const copies = await client.api(path + "memory-import");
    const receipt = copies.find((item) => !item.withdrawn);
    const heading = (title) => history.locator(".memory-material-heading").filter({ hasText: title });
    const copied = new Map();
    for (const title of ["Site plan", "Design review", "Building standards"]) {
      const material = receipt.materials.find((item) => item.title === title);
      const action = heading(title).locator("[data-memory-native-copy]");
      assert.equal(
        await action.locator(".memory-toolbar-label").isVisible(),
        !remote,
        tag + " " + title + " action label",
      );
      const request = { packageId: receipt.packageId, materialId: material.id };
      const repeat = remote
        ? (await action.click(), [])
        : await Promise.all([
            client.api(path + "memory-material-copy", request),
            client.api(path + "memory-material-copy", request),
            action.click(),
          ]);
      const opened = heading(title).locator("[data-memory-native-open]");
      await opened.waitFor();
      assert(
        await opened.evaluate((element) => element === element.ownerDocument.activeElement),
        tag + " " + title + " link focus",
      );
      const replay = await client.api(path + "memory-material-copy", request);
      if (repeat.length) {
        assert.deepEqual(repeat[0], replay);
        assert.deepEqual(repeat[1], replay);
      }
      copied.set(title, { ...replay, link: await opened.getAttribute("href") });
    }
    assert(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await client.page.screenshot({ path: join(out, "package-native-copies-" + tag + ".png") });
    const copiedDocument = copied.get("Building standards");
    const documentQuery = new URLSearchParams({ project: project.id, id: copiedDocument.id });
    const nativeDoc = await client.api("/api/project-documents/editor?" + documentQuery);
    assert.equal(nativeDoc.saved.revision.locale, "zh-CN");
    const restoredImage = nativeDoc.saved.revision.body.document.content.find((node) => node.type === "image");
    assert.equal(restoredImage.attrs.alt, "Site sketch");
    assert.equal(restoredImage.attrs.width, 64);
    assert.equal(nativeDoc.saved.revision.body.document.content[0].attrs.level, 2);
    const newImageId = new URL(restoredImage.attrs.src, "http://local.test").searchParams.get("id");
    assert.notEqual(newImageId, expected[3].id);
    const assets = await client.api(
      "/api/project-documents/assets?" + new URLSearchParams({ project: project.id, document: copiedDocument.id }),
    );
    assert.equal(assets.assets.length, 1);
    assert.equal(assets.assets[0].id, newImageId);
    assert.equal(assets.assets[0].digest, expected[3].digest);
    for (const [index, title] of ["Site plan", "Design review"].entries()) {
      const copy = copied.get(title);
      const query = new URLSearchParams({ project: project.id, id: copy.id });
      const { asset } = await client.api("/api/creative-assets/item?" + query);
      const original = await client.request("/api/creative-assets/content?" + query + "&version=" + asset.version);
      assert.equal(original.status(), 200);
      assert.deepEqual(await original.body(), expected[index]);
    }
    const otherProject = tag === "pc" ? source : await client.project("other-" + tag.toLowerCase());
    const foreign = await client.request("/api/projects/" + otherProject.id + "/memory-material-copy", {
      packageId: receipt.packageId,
      materialId: receipt.materials[0].id,
    });
    assert.equal(foreign.status(), 404);
    const identities = await client.api(path + "memory-import");
    assert.equal(
      identities.find((entry) => entry.packageId === receipt.packageId).copies[
        receipt.materials.find((item) => item.title === "Building standards").id
      ].id,
      copiedDocument.id,
    );
    if (tag === "pc") {
      const second = await client.request("/api/projects/" + source.id + "/memory-export", {
        publicKey: settings.publicKey,
        materials: receipt.materials.map(({ id, kind, version }) => ({ id, kind, version })),
      });
      assert.equal(second.status(), 200);
      await panel.locator("[data-memory-package-file]").setInputFiles({
        name: "repacked.pmf",
        mimeType: "application/vnd.pandaforce.memory",
        buffer: await second.body(),
      });
      await panel.locator("[data-memory-package-unlock] input").fill(phrase);
      await panel.locator("[data-memory-package-review]").click();
      await panel
        .locator("[data-memory-package-preview] .memory-package-materials")
        .getByText("site-plan.png")
        .waitFor();
      await panel.locator('button[type="submit"]').click();
      const additional = await waitFor(async () =>
        (await client.api(path + "memory-import")).find((item) => item.packageId !== receipt.packageId),
      );
      for (const row of additional.materials) {
        const again = await client.api(path + "memory-material-copy", {
          packageId: additional.packageId,
          materialId: row.id,
        });
        assert.equal(again.id, copied.get(row.title).id);
      }
    }
    const withdraw = panel.locator(`[data-package-withdraw="${receipt.packageId}"]`);
    await withdraw.click();
    await client.page.getByRole("alertdialog").locator("button.danger").click();
    await withdraw.waitFor({ state: "detached" });
    assert.equal((await client.request(links[0].href)).status(), 404);
    const rejected = await client.request(path + "memory-material-copy", {
      packageId: receipt.packageId,
      materialId: receipt.materials[0].id,
    });
    assert.equal(rejected.status(), 404);
    await panel.locator("[data-memory-package-close]").click();
    if (tag === "pc" || tag === "zh-TW") {
      await client.page.goto(new URL(copied.get("Design review").link, client.page.url()).href);
      const slide = client.page.locator("[data-slide-image]");
      await slide.waitFor({ timeout: 45000 });
      await client.page.locator("[data-slide-next]").click();
      await waitFor(
        async () =>
          (await client.page.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.join(",") === "2,2",
        45000,
      );
      await slide.waitFor({ timeout: 45000 });
      await client.page.screenshot({ path: join(out, "package-native-slides-" + tag + ".png") });
    }
    await client.page.goto(new URL(copiedDocument.link, client.page.url()).href);
    await client.page
      .locator('#documentEditor img[alt="Site sketch"]')
      .first()
      .waitFor({ timeout: 45000 })
      .catch(async (error) => {
        await client.page.screenshot({ path: join(out, "document-reader-failure-" + tag + ".png") });
        throw new Error(tag + " document reader: " + (await client.page.locator("body").innerText()).slice(-1600), {
          cause: error,
        });
      });
    const newBody = structuredClone(nativeDoc.working.body);
    newBody.document.content.push({ type: "paragraph", content: [{ type: "text", text: "Independent edit" }] });
    const revision = await client.api(
      "/api/project-documents/editor?" + documentQuery,
      {
        operationId: randomUUID(),
        version: nativeDoc.draft.version,
        baseRevisionId: nativeDoc.draft.baseRevisionId,
        working: { ...nativeDoc.working, body: newBody },
      },
      "PUT",
    );
    await client.api("/api/project-documents/checkpoints?" + documentQuery, {
      operationId: randomUUID(),
      revisionId: nativeDoc.saved.revision.id,
      draftVersion: revision.receipt.version,
    });
    assert.match(
      (await client.api("/api/project-documents/source?" + documentQuery)).revision.content,
      /Independent edit/u,
    );
  }
  console.log("Encrypted multimedia exports and restore paths passed on desktop and H5.");
} finally {
  try {
    await target?.dispose();
  } finally {
    try {
      await app.dispose();
    } finally {
      await s3?.close();
    }
  }
}
