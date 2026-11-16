import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { portableSourceArchive } from "../support/source-template.js";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";

const app = await createAppFixture();
await mkdir(".artifacts/source-install-stage", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await app.signIn(context);
      page = await context.newPage();
      await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
      const archive = await portableSourceArchive(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/skills/writing");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const center = page.locator(".template-manager");
      await center.locator("[data-template-menu] summary").click();
      await center.locator('[data-template-action="source-import"]').click();
      const dialog = page.locator("#sourceTemplateImport");
      await dialog.locator("[data-source-file]").setInputFiles({
        name: `library-${width}.zip`,
        mimeType: "application/zip",
        buffer: Buffer.from(archive.bytes),
      });
      await dialog.locator("[data-source-submit]:enabled").click();
      await dialog.locator('[data-source-action="inspect"]:visible').click();
      const library = dialog.locator('[data-source-candidate="portable-library"]');
      await library.locator("[data-source-choose]").click();
      const review = dialog.locator("[data-source-template-review]");
      await review.locator("[data-template-export]").first().waitFor();
      assert.equal(await review.locator("[data-template-export]").count(), 3);
      for (const checkbox of await review.locator("[data-template-export]").all())
        await checkbox.setChecked(
          ["example.article-outline@1.0.0", "example.brand-slides@1.0.0"].includes(await checkbox.inputValue()),
        );
      await review.locator('[data-import-action="review"]:enabled').click();
      await review.locator("#sourceTemplateAccept:enabled").check();
      assert.match(await review.locator(".package-review").innerText(), /MIT/);
      await page.screenshot({ path: `.artifacts/source-install-stage/review-${width}.png` });
      let firstReceipt = null,
        attempts = 0;
      await page.route("**/api/templates/from-source/install", async (route) => {
        attempts++;
        if (attempts !== 1) return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        firstReceipt = await response.json();
        await route.abort("failed");
      });
      await review.locator('#sourceTemplateApproval button[type="submit"]').click();
      await review.locator('[data-import-notice][data-error="true"]').waitFor();
      assert.ok(firstReceipt);
      const selected = firstReceipt.current.templates.find((value) => value.id === "example.article-outline"),
        disabled = await context.request.put(app.base + "/api/templates/state", {
          data: {
            id: selected.id,
            version: selected.version,
            digest: selected.digest,
            expectedRevision: firstReceipt.current.revision,
            action: "disable",
          },
        });
      assert.equal(disabled.status(), 200);
      const tasks = await (await context.request.get(app.base + "/api/package-sources?purpose=templates")).json();
      assert.equal(tasks.length, 1);
      const removed = await context.request.post(app.base + "/api/package-sources/remove", {
        data: { purpose: "templates", id: tasks[0].id, revision: tasks[0].revision },
      });
      assert.equal(removed.status(), 200);
      const receiptResponse = page.waitForResponse(
        (response) => response.url().endsWith("/api/templates/from-source/install") && response.status() === 201,
      );
      await review.locator('#sourceTemplateApproval button[type="submit"]:enabled').click();
      const retried = await (await receiptResponse).json();
      assert.deepEqual(retried.receipt, firstReceipt.receipt);
      assert.equal(retried.current.templates.find((value) => value.id === selected.id).enabled, false);
      await review.locator("#sourceTemplateApproval").waitFor({ state: "hidden" });
      assert.deepEqual(
        await (await context.request.get(app.base + "/api/package-sources?purpose=templates")).json(),
        [],
      );
      await dialog.locator('[data-source-action="close"]').click();
      await center.locator('[data-template-key^="portable:template:example.article-outline:"]').click();
      const detail = page.locator("#managedTemplateDialog");
      await detail.locator('[data-template-detail="export"]:visible').waitFor();
      assert.match(
        await detail.locator("[data-template-overview]").innerText(),
        locale === "en" ? /Imported source snapshot/ : /导入的来源快照/,
      );
      const download = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const path = await (await download).path();
      const exported = await parsePortableTemplateBundle(new Uint8Array(await readFile(path)));
      assert.equal(exported.templates[0].digest, selected.digest);
      await detail.locator('[data-template-detail="close"]').click();
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.artifacts/source-install-stage/installed-${width}.png` });
      console.log(
        `${engine.name()} ${width}: exact ZIP library selection, shared approval, lost-response replay after source cleanup, retained disabled state and full export passed`,
      );
      await context.close();
      if (width === 1440) {
        await app.stop();
        await app.start();
      }
    } catch (error) {
      if (page) await page.screenshot({ path: `.artifacts/source-install-stage/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
