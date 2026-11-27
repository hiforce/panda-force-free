import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createEncryptionKey } from "../../src/client/encryption-keys/key-store.ts";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.ts";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { materialPdf } from "../support/material-text.ts";

const proof = process.env.PANDA_FORCE_MEMORY_AUTHORING_PROOF || ".artifacts/project-memory-citations";
await mkdir(proof, { recursive: true });
const passphrase = "test only citation authoring key";
const backup = await createEncryptionKey("Citation fixture", passphrase);
const photo = await sharp("public/assets/skill-cover-information-architecture-v1.webp")
  .resize(760, 440)
  .png()
  .toBuffer();
const deck = await renderCreationSlides(
  [
    { layout: "content", title: "Overview", body: "First review." },
    { layout: "picture", title: "Ramp detail", body: "Second review.", imageHandle: "1".repeat(64) },
  ],
  async () => photo,
);
const draw = (color) => {
  const source = color + " rg 50 280 420 400 re f";
  return "<< /Length " + source.length + " >>\nstream\n" + source + "\nendstream";
};
const pdf = materialPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
  draw("0.8 0 0"),
  draw("0 0.52 0.64"),
]);

const app = await createAppFixture({ startupTimeoutMs: 60000, completedTurnNotifications: true });
let source;
let assets;
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 860 },
        locale,
        isMobile: width < 700,
        hasTouch: width < 700,
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === top && /^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", language);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      const request = (path, data, method = data === undefined ? "GET" : "POST") =>
        context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
      const api = async (...args) => {
        const result = await request(...args);
        assert(result.ok(), args[0] + (result.ok() ? "" : ": " + result.status() + " " + (await result.text())));
        return result.json();
      };
      const project = async (code) => {
        const { revision } = await api("/api/projects");
        const catalog = await api("/api/projects", { revision, name: "Architecture", code, operationId: randomUUID() });
        return catalog.projects.find((item) => item.code === code);
      };
      const projectUrl = (id) =>
        app.base + "/project?" + new URLSearchParams({ id, tab: "memory", memoryView: "records" });
      if (!source) {
        source = await project("design-origin");
        const policies = "/api/projects/" + source.id + "/memory-policy";
        await api(policies, { ...(await api(policies)), write: true }, "PATCH");
        const conversations = "/api/personal/harness/conversations";
        const created = await api(conversations, { projectId: source.id });
        const current = conversations + "/" + created.conversation.id;
        await api(current + "/runs", {
          requestId: randomUUID(),
          text: "Project convention [studio]: accessibility = place the ramp near the entrance",
        });
        const path = "/api/projects/" + source.id + "/";
        await waitFor(
          async () => (await api(path + "memory-export")).references.some(({ key }) => key === "accessibility"),
          30000,
        );
        const tree = await api("/api/project-document-tree/documents", {
          id: randomUUID(),
          projectId: source.id,
          treeVersion: 0,
          title: "Site notes",
          locale: "en",
          parentId: null,
        });
        const scope = new URLSearchParams({ project: source.id, id: tree.operation.documentId });
        const opened = await api("/api/project-documents/editor?" + scope);
        const body = {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Keep the access route within sight." }] },
              { type: "paragraph", content: [{ type: "text", text: "Second paragraph records the ramp width." }] },
            ],
          },
        };
        const draft = await api(
          "/api/project-documents/editor?" + scope,
          {
            operationId: randomUUID(),
            version: opened.draft.version,
            baseRevisionId: opened.draft.baseRevisionId,
            working: { ...opened.working, body },
          },
          "PUT",
        );
        await api("/api/project-documents/checkpoints?" + scope, {
          operationId: randomUUID(),
          revisionId: opened.saved.revision.id,
          draftVersion: draft.receipt.version,
        });
        assets = {};
        for (const [name, title, kind, bytes] of [
          ["Ramp.png", "Ramp photo", "image", photo],
          ["Access.pptx", "Access deck", "slides", deck.bytes],
          ["Code.pdf", "Building code", "file", pdf],
        ]) {
          const query = new URLSearchParams({
            id: "c-" + randomUUID(),
            operationId: randomUUID(),
            project: source.id,
            name,
            title,
            kind,
            locale: "en",
          });
          const saved = await context.request.post(app.base + "/api/creative-assets/import?" + query, {
            data: Buffer.from(bytes),
            headers: { Origin: app.base, "content-type": "application/octet-stream" },
          });
          assert(saved.ok(), await saved.text());
          assets[title] = (await saved.json()).asset;
        }
      }

      const target = await project("citation-target-" + locale.toLowerCase());
      const page = await context.newPage();
      await page.goto(projectUrl(source.id));
      await page.waitForFunction((language) => document.documentElement.lang === language, locale);
      await page.evaluate((value) => {
        localStorage.setItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey, JSON.stringify([value]));
      }, backup);
      await page.locator("[data-memory-packages-export]").click();
      const dialog = page.locator(".memory-package-dialog");
      const picker = dialog.locator("[data-package-material-picker]");
      await picker.locator("summary").click();
      const row = (title) =>
        picker.locator("[data-citation-material]").filter({ has: page.getByText(title, { exact: true }) });
      const editor = dialog.locator(".memory-citation-editor");
      const open = async (title) => {
        await row(title).getByText(title, { exact: true }).click();
        await row(title).locator("[data-citation-add]").click();
        await editor.locator("[data-citation-reference]").waitFor();
        await editor.locator("[data-citation-reference]").selectOption(JSON.stringify(["accessibility", "studio"]));
      };
      const save = async (title) => {
        await editor.locator("[data-citation-save]").click();
        await row(title).locator("[data-citation-edit]").waitFor();
        await waitFor(async () =>
          row(title)
            .locator("[data-citation-edit]")
            .evaluate((element) => element === document.activeElement),
        );
      };

      await open("Ramp photo");
      const region = editor.locator(".memory-citation-image img");
      await region.evaluate((element) => element.decode());
      if (locale === "en") {
        const box = await region.boundingBox();
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65, { steps: 6 });
        await page.mouse.up();
      } else {
        for (const [field, value] of [
          ["x", "20"],
          ["y", "25"],
          ["width", "50"],
          ["height", "40"],
        ])
          await editor.locator('[data-region-coordinate="' + field + '"]').fill(value);
      }
      assert.equal(await editor.locator('[data-region-coordinate="width"]').inputValue(), "50");
      assert(await editor.locator("[data-citation-save] svg").isVisible());
      assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: join(proof, "author-region-" + locale + ".png") });
      await save("Ramp photo");

      await open("Access deck");
      await editor.locator("[data-slide-next]").click({ timeout: 45000 });
      await waitFor(
        async () => (await editor.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.join(",") === "2,2",
      );
      await page.screenshot({ path: join(proof, "author-slide-" + locale + ".png") });
      await save("Access deck");
      if (locale === "en") {
        await row("Access deck").locator("[data-citation-add]").click();
        await editor.locator("[data-slide-image]").waitFor({ timeout: 45000 });
        await editor.locator("[data-citation-save]").click();
        await row("Access deck").locator('[data-citation-remove="1"]').click();
        assert.equal(await row("Access deck").locator("[data-citation-edit]").count(), 1);
      }
      await row("Access deck").locator("[data-citation-edit]").click();
      await editor.locator("[data-slide-image]").waitFor({ timeout: 45000 });
      await page.keyboard.press("Escape");
      await waitFor(async () =>
        row("Access deck")
          .locator("[data-citation-edit]")
          .evaluate((element) => element === document.activeElement),
      );

      await open("Building code");
      const pageNumber = editor.locator("[data-slide-jump]");
      await pageNumber.fill("2", { timeout: 45000 });
      await pageNumber.press("Enter");
      await waitFor(
        async () => (await editor.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.join(",") === "2,2",
      );
      await save("Building code");

      await picker.locator("[data-material-type]").selectOption("document");
      await open("Site notes");
      await editor.locator("[data-citation-paragraph]").selectOption("2");
      assert.equal(
        await editor.locator(".memory-material-target").textContent(),
        "Second paragraph records the ramp width.",
      );
      await save("Site notes");
      await picker.locator("[data-material-type]").selectOption("files");
      await row("Ramp photo").locator("[data-citation-edit]").waitFor();

      if (locale === "en") {
        const path = "/api/projects/" + source.id + "/";
        const slide = assets["Access deck"];
        const select = { id: slide.id, version: slide.version, kind: slide.kind };
        const exportWith = (key, number) =>
          request(path + "memory-export", {
            publicKey: backup.publicKey,
            materials: [{ ...select, anchors: [{ key, scope: "studio", location: { kind: "slide", number } }] }],
          });
        assert.equal((await exportWith("accessibility", 3)).status(), 400);
        assert.equal((await exportWith("withdrawn-record", 2)).status(), 409);
        const preview = (project, version) =>
          "/api/projects/" +
          project +
          "/memory-export-preview?" +
          new URLSearchParams({ ...select, version, page: "1" });
        assert.equal((await request(preview(target.id, slide.version))).status(), 404);
        assert.equal((await request(preview(source.id, "f".repeat(64)))).status(), 409);
      }

      const download = page.waitForEvent("download");
      await dialog.locator("[data-memory-package-export]").click();
      const file = await (await download).path();
      const bytes = Buffer.from(await Bun.file(file).arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString("hex"), "504d4602");
      await page.goto(projectUrl(target.id));
      await page.locator("[data-memory-packages-import]").click();
      await dialog
        .locator("[data-memory-package-file]")
        .setInputFiles({ name: "architect.pmf", mimeType: "application/vnd.pandaforce.memory", buffer: bytes });
      await dialog.locator("[data-memory-package-unlock] input").fill(passphrase);
      await dialog.locator("[data-memory-package-review]").click();
      await dialog.locator('button[type="submit"]').click();
      await dialog.locator("[data-package-withdraw]").waitFor();
      const [receipt] = await api("/api/projects/" + target.id + "/memory-import");
      const positions = Object.fromEntries(receipt.materials.map((row) => [row.title, row.anchors[0].location]));
      assert.deepEqual(positions, {
        "Ramp photo": { kind: "image", x: 0.2, y: 0.25, width: 0.5, height: 0.4 },
        "Access deck": { kind: "slide", number: 2 },
        "Building code": { kind: "page", number: 2 },
        "Site notes": { kind: "paragraph", number: 2 },
      });
      await dialog.locator("[data-memory-package-close]").click();
      await page.locator("[data-memory-sources] summary").click();
      await page.locator("[data-package-source]").click();
      await dialog.locator('[data-material="' + assets["Access deck"].id + '"][data-memory-material-anchor]').click();
      await dialog.locator("[data-slide-image]").waitFor({ timeout: 45000 });
      assert.deepEqual(
        (await dialog.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.map(Number),
        [2, 2],
      );
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Desktop and H5 author, edit and restore native material citations in encrypted project memory packages.",
  );
} finally {
  await app.dispose();
}
