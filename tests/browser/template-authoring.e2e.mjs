import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import { chromium, webkit, devices } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";

const app = await createAppFixture(),
  out = ".artifacts/template-authoring-browser";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "light"],
    [webkit, 390, "zh-CN", "dark"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    const context = await browser.newContext({
      ...(engine === webkit ? devices["iPhone 13"] : {}),
      viewport: { width, height: 960 },
      locale,
    });
    await context.addInitScript((theme) => {
      if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
    }, theme);
    await app.signIn(context);
    const page = await context.newPage(),
      errors = [],
      nativeDialogs = [],
      external = [],
      projectImages = [],
      saves = [];
    const runtimeRequests = [];
    let releaseRuntime;
    const runtimeGate = new Promise((resolve) => {
      releaseRuntime = resolve;
    });
    if (engine === chromium)
      await page.route("**/document-rich-runtime.bundle.js", async (route) => {
        runtimeRequests.push(route.request().resourceType());
        if (route.request().resourceType() === "script") await runtimeGate;
        await route.continue();
      });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
      if (request.url().includes("/api/document-assets/content")) projectImages.push(request.url());
      if (request.url() === app.base + "/api/template-drafts" && request.method() === "PUT")
        saves.push(request.postDataJSON());
    });
    try {
      await page.goto(app.base + "/skills/writing");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const center = page.locator(".template-manager"),
        editor = page.locator("#templateAuthoringEditor"),
        surface = editor.locator('.document-rich-content[contenteditable="true"]');
      if (engine === chromium) {
        assert.deepEqual(runtimeRequests, [], "Listing templates must not download or execute the editor");
      }
      await center.locator('[data-template-action="article"]').click();
      if (engine === chromium) {
        await editor.locator('[data-authoring-action="save"]:disabled').waitFor();
        if ((await editor.locator("[data-authoring-layout]").getAttribute("data-panel")) !== "true")
          await editor.locator('[data-authoring-action="settings"]').click();
        await editor.locator('[data-field="name-en"]').fill("Preserved while the editor loads");
        const retry = editor.locator('.document-runtime-status[role="alert"] button');
        await retry.waitFor();
        await page.screenshot({ path: `${out}/editor-slow-recoverable.png` });
        const imported = page.waitForResponse(
          (response) =>
            response.url().endsWith("/document-rich-runtime.bundle.js") &&
            response.request().resourceType() === "script",
        );
        releaseRuntime();
        await imported;
        await retry.click();
      }
      await surface.waitFor();
      if (engine === chromium) {
        assert.equal(await editor.locator('[data-field="name-en"]').inputValue(), "Preserved while the editor loads");
        assert.equal(runtimeRequests.filter((type) => type === "script").length, 1);
        assert.equal(await surface.count(), 1);
        await editor.locator('[data-authoring-action="settings"]').click();
      }
      if (width > 700) {
        const bounds = await editor.boundingBox();
        assert.ok(bounds && Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2);
        assert.ok(bounds && Math.abs(bounds.y + bounds.height / 2 - 480) < 2);
      }
      const caret = () =>
        page.waitForFunction(() => {
          const node = document.querySelector("#templateAuthoringEditor .document-rich-content"),
            selection = getSelection();
          if (node?.contains(document.activeElement) && document.activeElement?.matches(".cm-content"))
            return selection?.isCollapsed && node.editor.state.selection.empty && node.editor.isActive("codeBlock");
          return (
            node &&
            document.activeElement === node &&
            selection?.anchorNode &&
            node.contains(selection.anchorNode) &&
            selection.isCollapsed &&
            node.editor.state.selection.empty &&
            node.editor.state.selection.from === node.editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset)
          );
        });
      const id = "example.browser-article-" + width;
      const panel = async (open) => {
        const value = await editor.locator("[data-authoring-layout]").getAttribute("data-panel");
        if ((value === "true") !== open) await editor.locator('[data-authoring-action="settings"]').click();
      };
      const details = async (selector) => {
        const field = editor.locator(selector),
          parent = field.locator("xpath=ancestor::details[1]");
        if (!(await parent.evaluate((node) => node.open))) await parent.locator(":scope > summary").click();
      };
      await surface.click();
      await page.keyboard.insertText("A reusable article heading");
      await editor.locator("[data-rich-heading]").selectOption("2");
      await surface.locator("h2").waitFor();
      if (width > 700) {
        await surface.locator("h2").click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        await page.waitForFunction(() => getSelection().toString() === "A reusable article heading");
        const selection = page.locator(".document-selection-toolbar:visible");
        await selection.locator('[data-selection-action="bold"]').click();
        await surface.locator("h2 strong").waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await editor.evaluate((node) => node.open), true);
      }
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      await page.keyboard.insertText("Evidence remains editable.");
      await panel(true);
      await editor.locator('[data-field="id"]').fill(id);
      await editor.locator('[data-field="name-en"]').fill("Reusable evidence article");
      await editor.locator('[data-field="name-zh-CN"]').fill("可复用的证据文章");
      await details('[data-field="license"]');
      await editor.locator('[data-field="publisher"]').fill("Example author");
      await editor.locator('[data-field="license"]').fill("MIT");
      await editor.locator('[data-field="license-text"]').fill("MIT License — a disposable example template.");
      await editor.locator('[data-authoring-field-action="add-parameter"]').click();
      const parameter = editor.locator("[data-parameter-index]").first();
      await parameter.locator('[data-field="parameter-id"]').fill("audience");
      await parameter.locator('[data-field="parameter-type"]').selectOption("choice");
      await parameter.locator('[data-authoring-field-action="add-choice"]').click();
      await parameter.locator('[data-authoring-field-action="remove-choice"]').first().click();
      await parameter.locator('[data-authoring-field-action="add-choice"]').click();
      const choices = await parameter
        .locator('[data-field="choice-value"]')
        .evaluateAll((nodes) => nodes.map((node) => node.value));
      assert.equal(new Set(choices).size, 2);
      await parameter.locator('[data-field="default"]').fill(choices[0]);
      await parameter.locator('[data-authoring-field-action="insert-parameter"]').click();
      await surface.getByText("{{audience}}", { exact: false }).waitFor();
      await panel(true);
      await details("[data-authoring-slots]");
      await editor.locator('[data-authoring-field-action="add-slot"]').click();
      const slot = editor.locator("[data-slot-index]").first();
      await slot.locator('[data-field="slot-id"]').fill("summary");
      await slot.locator('[data-field="slot-kind"]').selectOption("plain-text");
      await slot.locator('[data-field="slot-default"]').fill("A verified summary.");
      await details('[data-field="instructions"]');
      await editor.locator('[data-field="instructions"]').fill("Verify facts and preserve source attribution.");
      await panel(false);
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      await editor.locator("[data-rich-insert-toggle]").click();
      const insert = page.locator(".document-insert-menu:visible");
      await insert.locator('[data-insert-action="codeBlock"]').click();
      await surface.locator(".document-code-block").waitFor();
      await caret();
      await page.keyboard.insertText("const templateBlock = true;");
      assert.equal(
        await surface.locator(".document-code-block .cm-content").innerText(),
        "const templateBlock = true;",
      );
      await editor.locator("[data-rich-block-toggle]").click();
      const block = page.locator(".document-block-menu:visible");
      await block.locator('[data-block-action="duplicate"]').click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#templateAuthoringEditor .document-rich-content .document-code-block").length ===
          2,
      );
      await editor.locator('[data-rich-action="undo"]').click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#templateAuthoringEditor .document-rich-content .document-code-block").length ===
          1,
      );
      await editor.locator("[data-rich-block-toggle]").click();
      await block.locator('[data-block-action="delete"]').click();
      await surface.locator(".document-code-block").waitFor({ state: "hidden" });
      await editor.locator("[data-rich-insert-toggle]").click();
      await insert.locator('[data-insert-action="table"]').click();
      const cell = surface.locator("table th").first();
      await cell.click();
      await caret();
      await page.keyboard.insertText("Reusable table value");
      assert.equal(await cell.innerText(), "Reusable table value");
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#345678" } })
        .png()
        .toBuffer();
      await editor
        .locator("[data-rich-image]")
        .setInputFiles({ name: "illustration.png", mimeType: "image/png", buffer: png });
      const image = surface.locator("img");
      await image.waitFor();
      await page.waitForFunction(
        () => document.querySelector("#templateAuthoringEditor .document-rich-content img")?.naturalWidth === 12,
      );
      assert.match(await image.getAttribute("src"), /\/api\/template-drafts\/images\/content/);
      const save = async () => {
        const response = page.waitForResponse(
          (response) => response.url() === app.base + "/api/template-drafts" && response.request().method() === "PUT",
        );
        await editor.locator('[data-authoring-action="save"]').click();
        const result = await response;
        assert.equal(result.status(), 200);
        await page.waitForFunction(
          () => document.querySelector("#templateAuthoringEditor")?.getAttribute("aria-busy") === "false",
        );
        return (await result.json()).current;
      };
      let saved = await save();
      assert.equal(saved.draft.revision, 2);
      assert.equal(saved.definition.images.length, 1);
      assert.match(JSON.stringify(saved.definition.body), /Reusable table value/);
      assert.match(JSON.stringify(saved.definition.body), /A reusable article heading/);
      assert.match(JSON.stringify(saved.definition.body), /Evidence remains editable/);
      assert.doesNotMatch(JSON.stringify(saved.definition.body), /const templateBlock/);
      assert.equal(saved.definition.parameters[0].id, "audience");
      assert.deepEqual(saved.definition.contentSlots, [
        { id: "summary", kind: "plain-text", default: "A verified summary." },
      ]);
      const draftId = saved.draft.id;
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      await page.keyboard.insertText("Saved before a lost acknowledgement.");
      let lose = true;
      await page.route(app.base + "/api/template-drafts", async (route) => {
        if (route.request().method() !== "PUT" || !lose) return route.continue();
        lose = false;
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 200);
        await route.abort("failed");
      });
      await editor.locator('[data-authoring-action="save"]').click();
      await editor.locator("[data-authoring-notice]:not([hidden])").waitFor();
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      await page.keyboard.insertText("Text typed after the acknowledgement was lost.");
      saved = await save();
      assert.equal(saved.draft.revision, 3);
      assert.deepEqual(saves.at(-1), saves.at(-2));
      assert.ok(await surface.textContent().then((text) => text.includes("Text typed after")));
      saved = await save();
      assert.equal(saved.draft.revision, 4);
      assert.match(JSON.stringify(saved.definition.body), /Text typed after/);
      await page.unroute(app.base + "/api/template-drafts");
      await surface.press("ControlOrMeta+End");
      await caret();
      await surface.press("Enter");
      await page.keyboard.insertText("Recovered after closing and refreshing.");
      await editor.locator('[data-authoring-action="close"]').click();
      await editor.waitFor({ state: "hidden" });
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await center.locator("[data-template-menu] summary").click();
      await center.locator('[data-template-action="article-drafts"]').click();
      await page
        .locator("#templateDraftLibrary article")
        .filter({ hasText: id })
        .locator('[data-draft-action="open"]')
        .click();
      await surface.waitFor();
      assert.match(await surface.textContent(), /Recovered after closing/);
      saved = await save();
      assert.equal(saved.draft.id, draftId);
      assert.equal(saved.draft.revision, 5);
      assert.equal(await editor.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      if (width < 700) {
        await panel(true);
        assert.equal(
          await editor.locator('[data-field="id"]').evaluate((node) => getComputedStyle(node).fontSize),
          "16px",
        );
        await panel(false);
        const toolbar = await editor.locator("[data-authoring-toolbar]").boundingBox(),
          bounds = await editor.boundingBox();
        assert.ok(
          toolbar && bounds && toolbar.x >= bounds.x && toolbar.x + toolbar.width <= bounds.x + bounds.width + 1,
        );
      }
      await page.screenshot({ path: `${out}/editor-${width}.png` });
      if (engine === chromium) {
        await page.setViewportSize({ width: 2048, height: 960 });
        for (const mode of ["comfortable", "wide", "fill"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.workbenchWidth = mode;
          }, mode);
          const geometry = await editor.evaluate((node) => ({
            width: node.getBoundingClientRect().width,
            content: node.querySelector(".document-rich-surface").getBoundingClientRect().width,
            body: node.querySelector(".template-authoring-body").getBoundingClientRect().width,
            overflow: node.scrollWidth > node.clientWidth + 1,
          }));
          assert.equal(geometry.overflow, false);
          assert.ok(
            Math.abs(geometry.width - { comfortable: 1320, wide: 1800, fill: 2024 }[mode]) < 2,
            JSON.stringify(geometry),
          );
          assert.ok(
            mode === "comfortable" ? geometry.content <= 901 : geometry.content > 1400,
            JSON.stringify(geometry),
          );
          await page.screenshot({ path: `${out}/editor-${mode}-2048.png` });
        }
        await page.evaluate(() => {
          document.documentElement.dataset.workbenchWidth = "comfortable";
        });
        await page.setViewportSize({ width, height: 960 });
      }
      await editor.locator('[data-authoring-action="publish"]').click();
      const release = page.locator("#templateAuthoringForm");
      await release.locator("[data-template-release-approve]").check();
      const publication = page.waitForResponse((response) => response.url().endsWith("/api/template-drafts/publish"));
      await release.locator('button[type="submit"]').click();
      assert.equal((await publication).status(), 201);
      await release.waitFor({ state: "hidden" });
      await editor.locator('[data-authoring-action="close"]').click();
      await center.locator("[data-template-search]").fill(id);
      await center.locator(`[data-template-key^="portable:template:${id}:"]`).click();
      const detail = page.locator("#managedTemplateDialog");
      await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
      await detail.locator('[data-template-detail="preview"]').click();
      await detail.locator("iframe").waitFor();
      const frame = await (await detail.locator("iframe").elementHandle()).contentFrame();
      await frame.locator("img").waitFor();
      await frame.waitForFunction(() => document.querySelector("img")?.naturalWidth === 12);
      assert.match(await frame.locator("img").getAttribute("src"), /^data:image\/png;base64,/);
      const download = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const exported = (
        await parsePortableTemplateBundle(new Uint8Array(await readFile(await (await download).path())))
      ).templates[0];
      const payload = JSON.parse(exported.text(exported.manifest.payload.path));
      assert.equal(payload.images.length, 1);
      assert.deepEqual(exported.read(payload.images[0].path), new Uint8Array(png));
      assert.equal(payload.instructions, "Verify facts and preserve source attribution.");
      assert.equal(payload.parameters, undefined);
      await detail.locator('[data-template-detail="edit"]').click();
      await surface.waitFor();
      await panel(true);
      assert.equal(await editor.locator('[data-field="version"]').inputValue(), "1.0.1");
      assert.equal(await editor.locator('[data-field="id"]').inputValue(), id);
      await details('[data-field="license-text"]');
      assert.match(await editor.locator('[data-field="license-text"]').inputValue(), /MIT License/);
      await editor.locator('[data-authoring-action="close"]').click();
      assert.deepEqual(errors, []);
      assert.deepEqual(nativeDialogs, []);
      assert.deepEqual(external, []);
      assert.deepEqual(projectImages, []);
      console.log(
        `${engine.name()} ${width}: rich template editing, structure, owned images, exact save retries, reload recovery, reviewed native release, opaque preview, export and version fork passed`,
      );
    } catch (error) {
      if (!page.isClosed()) {
        await page.screenshot({ path: `${out}/failure-${width}.png` });
        console.log(
          (
            await page
              .locator("#templateAuthoringEditor")
              .textContent()
              .catch(() => "")
          ).slice(0, 5000),
        );
      }
      throw error;
    } finally {
      releaseRuntime();
      await context.close();
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
