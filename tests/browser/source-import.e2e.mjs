import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { zipSync } from "fflate";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture();
await mkdir(".artifacts/source-product-stage", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page,
      releaseList = () => {},
      releaseUpload = () => {};
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await app.signIn(context);
      page = await context.newPage();
      await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
      const errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (req) => {
        if (/^https?:/.test(req.url()) && !req.url().startsWith(app.base)) external.push(req.url());
      });
      await page.goto(app.base + "/skills/writing");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const open = async () => {
          await page.locator("[data-template-menu] summary").click();
          await page.locator('[data-template-action="source-import"]').click();
        },
        dialog = page.locator("#sourceTemplateImport"),
        archive = zipSync(
          Object.assign(
            {
              "theme/layout/index.ejs": new TextEncoder().encode("<h1>Example theme</h1>"),
              "theme/alias.ejs": [new TextEncoder().encode("layout/index.ejs"), { os: 3, attrs: 0xa1ff0000 }],
            },
            Object.fromEntries(
              Array.from({ length: 225 }, (_, i) => [
                `theme/source/document-${String(i).padStart(3, "0")}.md`,
                new TextEncoder().encode("# Fixture source\n"),
              ]),
            ),
          ),
        );
      let held = false,
        uploadSeen;
      const listGate = new Promise((resolve) => {
          releaseList = resolve;
        }),
        uploadGate = new Promise((resolve) => {
          releaseUpload = resolve;
        }),
        uploadStarted = new Promise((resolve) => {
          uploadSeen = resolve;
        });
      await page.route("**/api/package-sources?purpose=templates", async (route) => {
        if (held) return route.continue();
        held = true;
        const response = await route.fetch();
        await listGate;
        await route.fulfill({ response });
      });
      await page.route("**/api/package-sources/upload?**", async (route) => {
        uploadSeen();
        await uploadGate;
        await route.continue();
      });
      await open();
      await dialog
        .locator("[data-source-file]")
        .setInputFiles({ name: `source-${width}.zip`, mimeType: "application/zip", buffer: Buffer.from(archive) });
      await dialog.locator("[data-source-submit]:enabled").click();
      await uploadStarted;
      const task = dialog.locator(".source-task");
      await task.waitFor();
      await dialog.locator("[data-source-kind]").selectOption("github");
      await dialog.locator("[data-source-repository]").fill("example/preserved-input");
      const staleList = page.waitForResponse((response) =>
        response.url().endsWith("/api/package-sources?purpose=templates"),
      );
      releaseList();
      await staleList;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await task.count(), 1);
      releaseUpload();
      const ready = locale === "en" ? "Source ready" : "来源已就绪";
      await page.waitForFunction(({ ready }) => document.querySelector("[data-source-status]")?.textContent === ready, {
        ready,
      });
      assert.equal(await dialog.locator("[data-source-repository]").inputValue(), "example/preserved-input");
      assert.equal(
        await dialog.locator("[data-source-repository]").evaluate((node) => node === document.activeElement),
        true,
      );
      await task.locator('[data-source-action="inspect"]').click();
      await dialog.locator(".source-file-list li").first().waitFor();
      const taskId = await task.getAttribute("data-source-task"),
        captured = await (
          await context.request.get(app.base + `/api/package-sources/inspect?purpose=templates&id=${taskId}`)
        ).json();
      assert.equal(captured.schema, "panda.package-source/v2");
      assert.equal(captured.links.files[0].path, "theme/alias.ejs");
      assert.equal(
        captured.files.some((file) => file.path === "theme/alias.ejs"),
        false,
      );
      assert.equal(await dialog.locator(".source-file-list li").count(), 100);
      await dialog.locator("[data-source-more-files]").click();
      assert.equal(await dialog.locator(".source-file-list li").count(), 200);
      await dialog.locator("[data-source-more-files]").click();
      assert.equal(await dialog.locator(".source-file-list li").count(), 226);
      assert.equal(await dialog.locator("[data-source-more-files]").isVisible(), false);
      assert.equal(await dialog.locator('[data-source-candidate="hexo-theme"]').count(), 1);
      assert.doesNotMatch(await dialog.innerText(), /\bsources\.[a-zA-Z]/);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.screenshot({ path: `.artifacts/source-product-stage/source-import-${width}.png` });
      await dialog.locator('[data-source-action="close"]').click();
      await open();
      await task.waitFor();
      await task.locator('[data-source-action="remove"]').click();
      await task.waitFor({ state: "hidden" });
      await page.unroute("**/api/package-sources/upload?**");

      const seed = await context.request.post(app.base + "/api/package-sources", {
        data: {
          purpose: "templates",
          operationId: randomUUID(),
          request: {
            source: {
              kind: "zip-upload",
              name: "resume.zip",
              bytes: archive.length,
              sha256: createHash("sha256").update(archive).digest("hex"),
            },
          },
        },
      });
      assert.equal(seed.status(), 202);
      const reserved = await seed.json();
      await dialog.locator('[data-source-action="refresh"]').click();
      const resumed = dialog.locator(`[data-source-task="${reserved.id}"]`);
      await resumed.waitFor();
      const chooser = page.waitForEvent("filechooser");
      await resumed.locator('[data-source-action="resume"]').click();
      await (
        await chooser
      ).setFiles({ name: "wrong.zip", mimeType: "application/zip", buffer: Buffer.from("not the accepted original") });
      await dialog.locator("[data-source-submit]:enabled").click();
      await dialog.locator('[data-source-notice][data-error="true"]').waitFor();
      assert.match(
        await dialog.locator("[data-source-notice]").textContent(),
        locale === "en" ? /do not match/ : /不一致/,
      );
      assert.equal(
        (
          await (
            await context.request.get(app.base + `/api/package-sources/task?purpose=templates&id=${reserved.id}`)
          ).json()
        ).state,
        "reserved",
      );
      await dialog
        .locator("[data-source-file]")
        .setInputFiles({ name: "resume.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
      await dialog.locator("[data-source-submit]:enabled").click();
      await page.waitForFunction(
        ({ id, ready }) =>
          document.querySelector(`[data-source-task="${id}"] [data-source-status]`)?.textContent === ready,
        { id: reserved.id, ready },
      );
      await resumed.locator('[data-source-action="remove"]').click();
      await resumed.waitFor({ state: "hidden" });
      await dialog.locator('[data-source-action="close"]').click();
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(
        `${engine.name()} ${width}: real linked ZIP upload, v2 inspection, stale-list fencing, stable form input, retained tasks, file pagination and exact-original resume passed`,
      );
    } catch (error) {
      if (page) await page.screenshot({ path: `.artifacts/source-product-stage/failure-${width}.png` });
      throw error;
    } finally {
      releaseList();
      releaseUpload();
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
