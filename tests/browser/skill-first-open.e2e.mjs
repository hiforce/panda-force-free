import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { encodeSkillBundle } from "../../src/server/skills/storage/codec.js";

const app = await createAppFixture(),
  out = ".artifacts/skill-first-open",
  measurements = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      locale,
      colorScheme: width < 700 ? "dark" : "light",
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await app.signIn(context);
      const fixture = await nativeSkillPackage("example.first-open-" + width),
        manifest = fixture.pack.manifest;
      const content = new TextDecoder().decode(encodeSkillBundle(fixture.pack));
      const api = async (path, data) => {
        const response = await context.request.post(app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const review = await api("/api/skill-packs/review", {
        content,
        name: "first-open.skill.json",
        selected: [manifest.skills[1].id],
      });
      await api("/api/skill-packs/install", {
        content,
        name: "first-open.skill.json",
        approval: {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
      });
      const page = await context.newPage(),
        errors = [],
        heavy = [],
        reads = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/\/(?:template-settings|writing-skill|document-rich-runtime)\.bundle\.js/.test(request.url()))
          heavy.push(request.url());
      });
      page.on("response", (response) => {
        if (response.url().includes("/api/template-catalog?")) reads.push(response);
      });
      await page.route("**/template-settings.bundle.js*", async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(app.base + "/skills/writing");
      await page.locator(".template-card").first().waitFor();
      const listing = await reads[0].json();
      const item = listing.templates.find((value) => value.reference.packageId === manifest.id);
      assert.ok(item);
      const started = performance.now();
      await page.locator(`[data-template-key="${item.key}"]`).click();
      const dialog = page.locator("#managedTemplateDialog");
      await dialog.waitFor({ state: "visible", timeout: 1000 });
      const frameMs = Math.round(performance.now() - started);
      await page.waitForFunction(
        () => document.querySelector("#managedTemplateDialog")?.getAttribute("aria-busy") === "false",
        undefined,
        { timeout: 1500 },
      );
      const readyMs = Math.round(performance.now() - started);
      assert.deepEqual(
        heavy,
        [],
        "Skill metadata and actions must work while all editor/administration downloads are unavailable",
      );
      assert.ok(await dialog.locator(".template-detail-cover svg").isVisible());
      await dialog.locator('[data-template-detail="export"]').waitFor();
      assert.equal(await dialog.locator('[data-template-detail="export"]').isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/detail-${width}.png` });
      await dialog.locator('[data-template-detail="close"]').click();
      await page.evaluate(() => {
        history.pushState({}, "", "/publish/website");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForFunction(
        () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
      );
      const site = page.locator(".template-card").first();
      await site.waitFor();
      await site.click();
      await dialog.waitFor({ state: "visible", timeout: 1000 });
      await page.waitForFunction(
        () => document.querySelector("#managedTemplateDialog")?.getAttribute("aria-busy") === "false",
        undefined,
        { timeout: 1500 },
      );
      assert.deepEqual(heavy, [], "Site metadata must not load authoring or rich preview code either");
      await dialog.locator('[data-template-detail="close"]').click();
      await page.evaluate(() => {
        history.pushState({}, "", "/skills/writing");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForFunction(
        () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
      );
      const createStarted = performance.now();
      await page.locator('[data-template-action="article"]').click();
      const editor = page.locator("#templateAuthoringEditor");
      await editor.waitFor({ state: "visible", timeout: 2000 });
      const createFrameMs = Math.round(performance.now() - createStarted);
      await editor.locator('.document-rich-content[contenteditable="true"]').waitFor();
      const createReadyMs = Math.round(performance.now() - createStarted);
      assert.equal(
        heavy.some((url) => url.includes("/template-settings.bundle.js")),
        false,
        "Writing must load its own entry, independently of the blocked import/preview bundle",
      );
      assert.ok(heavy.some((url) => url.includes("/writing-skill.bundle.js")));
      await page.screenshot({ path: `${out}/create-${width}.png` });
      await editor.locator('[data-authoring-action="close"]').click();
      const requested = page.waitForRequest((request) => request.url().includes("/template-settings.bundle.js"));
      await page.locator(`[data-template-key="${item.key}"]`).click();
      await page.waitForFunction(
        () => document.querySelector("#managedTemplateDialog")?.getAttribute("aria-busy") === "false",
      );
      await dialog.locator('[data-template-detail="preview"]').click();
      await requested;
      assert.equal(await dialog.isVisible(), true);
      const loaded = page.waitForResponse(
        (response) =>
          response.url().includes("/template-settings.bundle.js") && response.request().resourceType() === "script",
      );
      release();
      await loaded;
      await dialog.locator("iframe").waitFor();
      await page.waitForFunction(
        () => document.querySelector("#managedTemplateDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.screenshot({ path: `${out}/preview-${width}.png` });
      assert.deepEqual(errors, []);
      const legacy = await context.newPage();
      await legacy.goto(app.base + "/workspace");
      await legacy.evaluate(async (item) => {
        const runtime = await import("/template-settings.bundle.js");
        if (typeof runtime.prepareWritingEditor !== "function") throw Error("Existing-page export was removed");
        globalThis.__legacySkillCommands = runtime.createTemplateCommands((id) => id, "existing-page", {
          refresh() {},
          notice() {},
          creationStatus() {},
        });
        await globalThis.__legacySkillCommands.run("detail", item);
      }, item);
      await legacy.locator('#managedTemplateDialog[open][aria-busy="false"]').waitFor();
      await legacy.locator('[data-template-detail="close"]').click();
      await legacy.evaluate(() => globalThis.__legacySkillCommands.run("article"));
      await legacy.locator('#templateAuthoringEditor .document-rich-content[contenteditable="true"]').waitFor();
      await legacy.evaluate(() => globalThis.__legacySkillCommands.close());
      await legacy.close();
      measurements.push({
        browser: engine.name(),
        width,
        detailFrameMs: frameMs,
        detailReadyMs: readyMs,
        createFrameMs,
        createReadyMs,
        writingDoesNotLoadImportRuntime: true,
        editorRequestsBeforePreview: 0,
        delayedPreviewRecovered: true,
        existingPageCommandContractPreserved: true,
      });
    } finally {
      release();
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/measurements.json",
    JSON.stringify(
      {
        conditions:
          "Fresh browser contexts on isolated local data; editor/administration module deliberately blocked until explicit preview. No remote device or network SLA is implied.",
        measurements,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Fresh PC/H5 skill and site details open independently of blocked administration/editor modules; rich previews remain lazy.",
  );
} finally {
  await app.dispose();
}
