import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { unzipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { nativeSlidesFixture } from "../support/native-slides.js";

const artifact = ".artifacts/native-slides-product";
await mkdir(artifact, { recursive: true });
const original = await nativeSlidesFixture("1.0.0", { slides: 2 });
let exchanged = null;
const checks = [];
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
]) {
  const app = await createAppFixture();
  let browser;
  try {
    browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    await app.signIn(context);
    await context.addInitScript(
      ({ locale, theme }) => {
        if (window === window.top) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        }
      },
      { locale, theme: width === 390 ? "dark" : "light" },
    );
    const page = await context.newPage(),
      errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(app.base)) external.push(request.url());
    });
    await page.goto(app.base + "/skills/slides");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    const center = page.locator(".template-manager"),
      dialog = page.locator("#sourceTemplateImport"),
      form = dialog.locator("[data-source-office-review]"),
      detail = page.locator("#managedTemplateDialog");
    async function upload(bytes, name, kind) {
      await center.locator("[data-template-menu] summary").click();
      await center.locator('[data-template-action="source-import"]').click();
      await dialog
        .locator("[data-source-file]")
        .setInputFiles({ name, mimeType: "application/zip", buffer: Buffer.from(bytes) });
      if (width === 390) {
        for (const selector of ["[data-source-kind]", "[data-source-file]"]) {
          const geometry = await dialog.locator(selector).evaluate((input) => {
            const label = input.closest("label"),
              caption = document.createRange();
            caption.selectNodeContents(label.firstChild);
            const box = input.getBoundingClientRect(),
              text = caption.getBoundingClientRect();
            return {
              below: box.top >= text.bottom,
              width: box.width,
              available: label.clientWidth,
              font: parseFloat(getComputedStyle(input).fontSize),
              height: box.height,
            };
          });
          assert.ok(
            geometry.below && geometry.width >= geometry.available - 2 && geometry.font >= 16 && geometry.height >= 44,
            JSON.stringify(geometry),
          );
        }
        await page.screenshot({ path: `${artifact}/source-form-${width}.png` });
      }
      await dialog.locator("[data-source-submit]:enabled").click();
      const task = dialog
        .locator("[data-source-task]")
        .filter({ has: page.locator("[data-source-name]", { hasText: name }) })
        .first();
      await task.locator('[data-source-action="inspect"]:visible').click();
      await dialog.locator(`[data-source-candidate="${kind}"] [data-source-choose]`).click();
      await form.locator("[data-office-review]:enabled").waitFor();
    }
    async function approve({ loseResponse = false } = {}) {
      const calls = [];
      if (loseResponse)
        await page.route("**/api/templates/native-slides/install", async (route) => {
          calls.push(route.request().postDataJSON());
          if (calls.length === 1) {
            const result = await route.fetch();
            assert.equal(result.status(), 201);
            await route.abort("failed");
          } else await route.continue();
        });
      assert.equal(await form.locator("[data-office-accept]").evaluate((node) => node.checkValidity()), false);
      await form.locator("[data-office-license]").check();
      if (loseResponse) {
        await form.locator("[data-office-accept] button").click();
        await form.locator('[data-office-notice][data-error="true"]').waitFor();
        const stage = await (
          await context.request.get(app.base + "/api/package-sources/task?purpose=templates&id=" + calls[0].source.id)
        ).json();
        const removed = await context.request.post(app.base + "/api/package-sources/remove", {
          data: { purpose: "templates", id: stage.id, revision: stage.revision },
        });
        assert.equal(removed.ok(), true);
        assert.equal(await form.locator("[data-office-license]").isChecked(), true);
      }
      const completed = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/templates/native-slides/install") && response.request().method() === "POST",
      );
      await form.locator("[data-office-accept] button:enabled").click();
      const result = await completed;
      assert.equal(result.status(), 201);
      const installed = await result.json();
      await form
        .locator('[data-office-notice][data-error="false"]')
        .filter({ hasText: /Installed|安装/ })
        .waitFor();
      if (loseResponse) {
        assert.equal(calls.length, 2);
        assert.equal(calls[0].approval.operationId, calls[1].approval.operationId);
        await page.unroute("**/api/templates/native-slides/install");
      }
      return installed;
    }
    async function openEntry(id) {
      await dialog.locator('[data-source-action="close"]').click();
      await center.locator('[data-template-action="refresh"]').click();
      const card = center
        .locator(".template-card")
        .filter({ hasText: id === "ui.office-desktop" ? "Desktop deck" : "Mobile deck" });
      await card.click();
      await detail.locator("a[download]").waitFor();
    }
    if (width === 390) {
      assert.ok(exchanged);
      await upload(exchanged, "desktop-template.zip", "powerpoint-bundle");
      assert.equal(await form.locator("[data-office-definition]").isVisible(), false);
      await form.locator("[data-office-customize]").check();
      await form.locator('[data-office-slot="id"]').waitFor({ state: "visible" });
      assert.equal(await form.locator('[data-office-slot="id"]').first().inputValue(), "title");
      await form.locator('[data-office-slot="id"]').first().fill("temporary_mobile_edit");
      await form.locator("[data-office-customize]").uncheck();
      const reviewResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/templates/native-slides/review"),
      );
      await form.locator("[data-office-review]").click();
      const review = await reviewResponse;
      assert.equal(review.status(), 200);
      assert.equal(review.request().postDataJSON().definition, null);
      await approve();
      await openEntry("ui.office-desktop");
      const returned = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const files = unzipSync(new Uint8Array(await readFile(await (await returned).path())));
      const prior = unzipSync(exchanged);
      for (const name of ["original.potx", "mapping.json", "LICENSE", "README.md"])
        assert.deepEqual(files[name], prior[name]);
      await detail.locator('[data-template-detail="close"]').click();
      checks.push(
        "H5 installs an unchanged PC-exported bundle in a fresh application; hidden customization does not rewrite its mapping or notices",
      );
    }
    const id = width === 390 ? "ui.office-mobile" : "ui.office-desktop";
    await upload(original.original, `raw-${width}.potx`, "powerpoint-template");
    const title = width === 390 ? "Mobile deck" : "Desktop deck";
    await form.locator('[data-office-field="id"]').fill(id);
    await form.locator('[data-office-field="name"]').fill(title);
    await form.locator('[data-office-field="publisher"]').fill("Fixture author");
    await form
      .locator('[data-office-field="licenseText"]')
      .fill("Private template license. <script>window.officeInjected = true</script>");
    const row = form.locator('[data-office-shape="2"]').first();
    await row.locator("[data-office-map]").check();
    await row.locator('[data-office-slot="label"]').fill("Document title");
    await row.locator('[data-office-slot="required"]').check();
    await row.locator('[data-office-slot="id"]').fill("title");
    const selector = form.locator("[data-office-part]");
    if (width === 1440) {
      let held = null;
      await page.route("**/api/templates/native-slides/part", async (route) => {
        if (route.request().postDataJSON().part === original.presentation.index.slides[0].path) held = route;
        else await route.continue();
      });
      await selector.selectOption(original.presentation.index.slides[0].path);
      await waitFor(() => held);
      await selector.selectOption(original.presentation.index.layouts[0].path);
      await row.locator('[data-office-slot="id"]').waitFor({ state: "visible" });
      assert.equal(await row.locator('[data-office-slot="id"]').inputValue(), "title");
      const staleResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/templates/native-slides/part") &&
          response.request().postDataJSON().part === original.presentation.index.slides[0].path,
      );
      await held.continue();
      await (await staleResponse).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.unroute("**/api/templates/native-slides/part");
      assert.equal(await selector.inputValue(), original.presentation.index.layouts[0].path);
      assert.equal(await row.locator('[data-office-slot="id"]').inputValue(), "title");
      checks.push("A delayed earlier part response cannot replace the currently selected layout or its edits");
    }
    await selector.selectOption(original.presentation.index.slides[1].path);
    await row.locator("[data-office-map]").waitFor();
    await row.locator("[data-office-map]").check();
    await row.locator('[data-office-slot="id"]').fill("slide_title");
    await selector.selectOption(original.presentation.index.layouts[0].path);
    await row.locator('[data-office-slot="id"]').waitFor({ state: "visible" });
    assert.equal(await row.locator('[data-office-slot="id"]').inputValue(), "title");
    assert.equal(await row.locator('[data-office-slot="required"]').isChecked(), true);
    await dialog.locator('[data-source-action="refresh"]').click();
    assert.equal(await row.locator('[data-office-slot="id"]').inputValue(), "title");
    assert.equal(await form.locator('[data-office-field="id"]').inputValue(), id);
    const reviewRequest = page.waitForResponse((response) =>
      response.url().endsWith("/api/templates/native-slides/review"),
    );
    await row.locator('[data-office-slot="id"]').press("Enter");
    const reviewed = await reviewRequest;
    assert.equal(reviewed.status(), 200);
    assert.equal(reviewed.request().postDataJSON().definition.mapping.slots[0].id, "title");
    assert.equal(reviewed.request().postDataJSON().definition.mapping.slots[0].required, true);
    assert.equal(await page.evaluate(() => window.officeInjected), undefined);
    const bounds = await dialog.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      viewport: innerWidth,
      overflow: node.scrollWidth > node.clientWidth + 1,
    }));
    assert.ok(bounds.width <= bounds.viewport && !bounds.overflow, JSON.stringify(bounds));
    await page.screenshot({ path: `${artifact}/import-${width}.png`, fullPage: false });
    await form.screenshot({ path: `${artifact}/mapping-form-${width}.png` });
    const installed = await approve({ loseResponse: width === 1440 });
    assert.equal(installed.current.templates.filter((value) => value.id === id).length, 1);
    await openEntry(id);
    assert.equal(await detail.locator('[data-template-detail="preview"]').isVisible(), false);
    const native = page.waitForEvent("download");
    await detail.locator("a[download]").click();
    const nativeFile = await native;
    assert.ok(nativeFile.suggestedFilename().endsWith(".potx"));
    assert.deepEqual(new Uint8Array(await readFile(await nativeFile.path())), original.original);
    const bundleDownload = page.waitForEvent("download");
    await detail.locator('[data-template-detail="export"]').click();
    const exported = new Uint8Array(await readFile(await (await bundleDownload).path()));
    const contents = unzipSync(exported);
    assert.deepEqual(contents["original.potx"], original.original);
    assert.equal(JSON.parse(new TextDecoder().decode(contents["mapping.json"])).slots[0].id, "title");
    if (width === 1440) exchanged = exported;
    await detail.locator('[data-template-detail="toggle"]').click();
    await detail.waitFor({ state: "hidden" });
    const snapshot = await (await context.request.get(app.base + "/api/templates/native-slides")).json();
    assert.equal(snapshot.templates.find((value) => value.id === id).enabled, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    checks.push(
      `${width}px ${locale}: raw native import, editable slot mapping, explicit license, exact original/bundle downloads and private disable`,
    );
  } finally {
    await browser?.close();
    await app.dispose();
  }
}
await writeFile(`${artifact}/browser-checks.private.json`, JSON.stringify({ passed: true, checks }, null, 2) + "\n");
console.log(checks.join("\n"));
