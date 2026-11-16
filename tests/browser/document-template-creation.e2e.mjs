import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { chromium, webkit, devices } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { DocumentTemplateAuthoring } from "../../src/server/templates/authoring/document.js";
import { createPortableTemplateTypes, templateDocumentCodec } from "../../src/server/templates/integration/types.js";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import { exportPortableTemplates } from "../../src/shared/templates/portable/bundle.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";

const app = await createAppFixture(),
  out = ".artifacts/document-template-creation-browser";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        ...(engine === webkit ? devices["iPhone 13"] : {}),
        viewport: { width, height: 960 },
        locale,
      });
      await context.addInitScript(
        (theme) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
        },
        width < 700 ? "dark" : "light",
      );
      await app.signIn(context);
      const api = async (path, data, method = data === undefined ? "get" : "post") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const bytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: "#4263eb" } })
          .png()
          .toBuffer(),
        image = {
          id: crypto.randomUUID(),
          path: "images/cover.png",
          mediaType: "image/png",
          bytes: bytes.length,
          sha256: await contentSha256(bytes),
          width: 16,
          height: 9,
        },
        definition = emptyDocumentTemplate("example.article-creation-" + width);
      definition.name = { en: "Project introduction", "zh-CN": "项目介绍" };
      definition.parameters = [{ id: "topic", type: "text", label: { en: "Topic", "zh-CN": "主题" }, required: true }];
      definition.contentSlots = [{ id: "body", kind: "rich-text", default: "Initial body" }];
      definition.images = [image];
      definition.body.document.content = [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "{{topic}}" }] },
        { type: "paragraph", content: [{ type: "text", text: "{{body}}" }] },
        { type: "image", attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Example illustration" } },
      ];
      const template = await new DocumentTemplateAuthoring(createPortableTemplateTypes(), templateDocumentCodec).create(
          definition,
          { read: async () => bytes },
        ),
        content = new TextDecoder().decode(await exportPortableTemplates([template])),
        review = await api("/api/templates/review", { content, name: "article.json" });
      await api("/api/templates/install", {
        content,
        name: "article.json",
        approval: {
          operationId: crypto.randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
      });
      const catalog = await api("/api/projects"),
        projects = await api("/api/projects", {
          code: "template-creation-" + width,
          name: "Example project",
          revision: catalog.revision,
        }),
        project = projects.projects.find((p) => p.code === "template-creation-" + width),
        page = await context.newPage(),
        errors = [],
        dialogs = [],
        commands = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      page.on("request", (request) => {
        if (request.url() === app.base + "/api/project-documents/from-template") commands.push(request.postDataJSON());
      });
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const directory = async () => {
        if (width < 700 && !(await page.locator("#authoringDirectory").isVisible()))
          await page
            .locator('[data-authoring-action="reader-directory"]:visible,[data-authoring-action="directory"]:visible')
            .click();
      };
      await directory();
      await page.locator(".document-workspace-more summary").click();
      await page.locator('[data-authoring-action="new-template"]:visible').click();
      const picker = page.locator("#documentTemplatePicker"),
        choose = async () => {
          await picker
            .locator(".document-template-choice")
            .filter({ hasText: locale === "en" ? "Project introduction" : "项目介绍" })
            .click();
          await picker.locator("#apply-template-topic").waitFor();
        };
      await choose();
      await picker.locator("#document-template-title").fill("A reusable project guide");
      await picker.locator("#apply-template-topic").fill("Project overview");
      await picker
        .locator("#apply-template-body")
        .fill(
          "- A clear goal\n- An editable result\n\n| Item | Status |\n| --- | --- |\n| Source | Ready |\n\n[Reference](https://example.test)",
        );
      await picker.locator("[data-picker-preview] summary").click();
      await picker.locator("iframe").waitFor();
      await page.screenshot({ path: `${out}/picker-${width}.png`, fullPage: true });
      const firstCreation = page.waitForResponse(
        (response) => response.url() === app.base + "/api/project-documents/from-template",
      );
      await picker.locator('[type="submit"]').click();
      const firstResponse = await firstCreation;
      assert.equal(firstResponse.status(), 201, (await firstResponse.text()) + " " + JSON.stringify(commands.at(-1)));
      await picker.waitFor({ state: "hidden" });
      const surface = page.locator('.document-rich-content[contenteditable="true"]');
      await surface.waitFor();
      const id = new URL(page.url()).searchParams.get("document"),
        scope = new URLSearchParams({ project: project.id, id });
      assert.ok(id);
      assert.equal(await surface.locator("table").count(), 1);
      assert.equal(await surface.locator("ul").count(), 1);
      await waitFor(() => surface.locator("img").evaluate((node) => node.complete && node.naturalWidth === 16));
      assert.equal(await page.locator("#documentTitle").inputValue(), "A reusable project guide");
      await page.locator("#documentTitle").fill("Edited after applying a template");
      await waitFor(
        async () =>
          (await api("/api/project-documents/editor?" + scope)).working.title === "Edited after applying a template",
      );
      await page.locator('.document-file-commands [data-doc-action="save"]').click();
      await waitFor(
        async () =>
          (await api("/api/project-documents/source?" + scope)).document.title === "Edited after applying a template",
      );
      await page.locator('[data-doc-action="preview"]').click();
      await directory();
      await page.locator(`[data-tree-id="${id}"] .document-tree-more`).click();
      await page.locator('[data-node-command="new-child-template"]').click();
      await choose();
      await picker.locator("#document-template-title").fill("Recovered child document");
      await picker.locator("#apply-template-topic").fill("Recovered topic");
      await picker.locator("#apply-template-body").fill("Recovered editable content. ".repeat(400));
      let lose = true,
        accepted = false;
      await page.route(app.base + "/api/project-documents/from-template", async (route) => {
        if (!lose) return route.continue();
        lose = false;
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        accepted = true;
        await route.abort("failed");
      });
      await picker.locator('[type="submit"]').click();
      await waitFor(() => accepted);
      await picker.waitFor({ state: "hidden" });
      const ref = new URLSearchParams({ id: definition.id, version: definition.version, digest: template.digest }),
        detail = await api("/api/templates/detail?" + ref);
      await api(
        "/api/templates/state",
        { ...Object.fromEntries(ref), action: "disable", expectedRevision: detail.revision },
        "put",
      );
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await directory();
      await page.locator('[data-authoring-action="retry-tree"]:visible').click();
      await surface.waitFor();
      assert.equal(await page.locator("#documentTitle").inputValue(), "Recovered child document");
      const childId = new URL(page.url()).searchParams.get("document"),
        tree = await api("/api/project-document-tree?" + new URLSearchParams({ project: project.id })),
        child = await api("/api/project-documents/source?" + new URLSearchParams({ project: project.id, id: childId }));
      assert.equal(tree.nodes.length, 2);
      assert.equal(tree.nodes.find((node) => node.documentId === childId).parentId, id);
      assert.match(child.revision.content, /Recovered editable content/);
      assert.deepEqual(commands.at(-1), commands.at(-2));
      assert.equal((await api("/api/templates/detail?" + ref)).template.enabled, false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: `${out}/editor-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
console.log("PASS document template creation, native editing and lost-response recovery on PC and H5");
