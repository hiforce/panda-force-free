import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { officeFixture } from "../support/office-presentation.js";

let outsideRequests = 0;
const outside = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      outsideRequests++;
      return new Response("Unexpected external request");
    },
  }),
  app = await createAppFixture(),
  out = ".artifacts/authored-assets-workspace/screens";
await mkdir(out, { recursive: true });
const html = (width, updated = false) =>
  Buffer.from(
    `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${outside.url}"><style>@import url('${outside.url}style.css');body{margin:0;font-family:system-ui;background:#f6f3ee;color:#192e42}header{background:#18364b;color:white;padding:28px}main{padding:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}article{background:white;padding:16px;border-radius:12px}h1{font-size:28px}h2{font-size:18px}@media(max-width:500px){.grid{grid-template-columns:1fr}}</style></head><body onload="parent.__nativeAssetExecuted=true"><header><small>STUDIO / RELEASE NOTES</small><h1>${updated ? "Updated personal page" : "Release plan " + width}</h1><p>A focused plan for a dependable launch.</p></header><main class="grid"><article><h2>Build with clarity</h2><p>Current requirements and source evidence.</p></article><article><h2>Ship with confidence</h2><p>Review each change before delivery.</p></article></main><script>parent.__nativeAssetExecuted=true;fetch('${outside.url}script')</script><iframe src="${outside.url}frame"></iframe><img src="${outside.url}image"><a href="${outside.url}link">External</a></body></html>`,
  );
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1050 },
        locale,
        colorScheme: width === 1440 ? "light" : "dark",
        acceptDownloads: true,
      });
    try {
      await app.signIn(context);
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const state = await api("/api/projects"),
        catalog = await api("/api/projects", {
          code: "native-" + width,
          name: "Launch workspace " + width,
          revision: state.revision,
        }),
        project = catalog.projects.find((p) => p.code === "native-" + width).id;
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const ready = async () => {
        await page.waitForFunction(
          () => document.querySelector("[data-creative-grid]")?.getAttribute("aria-busy") === "false",
        );
      };
      const snap = async (name) => {
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name);
        await page.screenshot({ path: `${out}/${name}-${width}.png` });
      };
      await page.goto(app.base + "/create?view=works");
      await ready();
      const title = "Release plan " + width + " <V2>";
      const importFile = async (name, buffer, newTitle) => {
        await page.locator("[data-creative-import]").click();
        const dialog = page.locator("dialog.creative-asset-dialog[open]");
        await dialog.waitFor();
        await dialog
          .locator("[name=document-source]")
          .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
        await dialog.locator("[name=document-title]").fill(newTitle);
        if (name.endsWith(".html")) await snap("import");
        const response = page.waitForResponse(
          (r) => r.url().includes("/api/creative-assets/import?") && r.request().method() === "POST",
        );
        await dialog.locator("button[type=submit]").click();
        const r = await response;
        assert.equal(r.status(), 201, await r.text());
        await dialog.waitFor({ state: "hidden" });
        await ready();
        return (await r.json()).asset;
      };
      const saved = await importFile("launch.html", html(width), title);
      assert.equal(saved.kind, "web");
      await page.locator(`[data-creative-asset="${saved.id}"]`).first().click();
      let dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator("[data-asset-frame]").waitFor();
      assert.equal(await dialog.locator("header h2").innerText(), title);
      assert.equal(await dialog.locator("[data-asset-frame]").getAttribute("sandbox"), "");
      assert.equal(await dialog.frameLocator("[data-asset-frame]").locator("h1").innerText(), "Release plan " + width);
      assert.equal(await page.evaluate(() => window.__nativeAssetExecuted), undefined);
      assert.equal(outsideRequests, 0);
      await snap("web-preview");
      const download = page.waitForEvent("download");
      await dialog.locator("a[download]").click();
      const file = await download;
      assert.deepEqual(await readFile(await file.path()), html(width));
      await dialog.locator("[data-asset-copy]").click();
      dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator(`[name="project-${project}"]`).check();
      await dialog.locator("button[type=submit]").click();
      await dialog.waitFor({ state: "hidden" });
      const copied = (await api("/api/creative-assets?project=" + project)).assets.find((a) => a.title === title);
      assert.equal(copied.copiedFrom.version, saved.version);
      await page.locator(`[data-creative-asset="${saved.id}"]`).first().click();
      dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator("[data-asset-replace]").click();
      await dialog
        .locator("[name=document-source]")
        .setInputFiles({ name: "launch.html", mimeType: "text/html", buffer: html(width, true) });
      const replacement = page.waitForResponse(
        (r) => r.url().includes("/api/creative-assets/import?") && r.request().method() === "POST",
      );
      await dialog.locator("button[type=submit]").click();
      assert.equal((await replacement).status(), 201);
      await dialog.waitFor({ state: "hidden" });
      await ready();
      const current = await api("/api/creative-assets/item?project=personal&id=" + saved.id);
      assert.notEqual(current.asset.version, saved.version);
      assert.match(current.text, /Updated personal page/);
      await page.goto(app.base + "/project?id=" + project);
      await ready();
      await page.locator(`[data-creative-asset="${copied.id}"]`).first().click();
      dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator("[data-asset-frame]").waitFor();
      assert.equal(await dialog.frameLocator("[data-asset-frame]").locator("h1").innerText(), "Release plan " + width);
      await dialog.locator("[data-doc-close]").click();
      await snap("project");
      await page.goto(app.base + "/create?view=works");
      await ready();
      const deck = officeFixture({ slides: 2 }).bytes(),
        slides = await importFile("architecture.pptx", Buffer.from(deck), "Architecture " + width);
      await snap("mixed");
      await page.locator(`[data-creative-asset="${slides.id}"]`).first().click();
      dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator(".creative-asset-sections section").nth(1).waitFor();
      assert.equal(await dialog.locator(".creative-asset-sections section").count(), 2);
      assert.match(await dialog.locator(".creative-asset-sections").innerText(), /Hello world/);
      await snap("slides");
      const deckDownload = page.waitForEvent("download");
      await dialog.locator("a[download]").click();
      assert.deepEqual(await readFile(await (await deckDownload).path()), Buffer.from(deck));
      await dialog.locator("[data-asset-trash]").click();
      await dialog.locator("button[type=submit]").click();
      await dialog.waitFor({ state: "hidden" });
      await ready();
      await page.locator("[data-creative-filter=trash]").click();
      await ready();
      await page.locator(`[data-creative-asset="${slides.id}"]`).first().waitFor();
      await snap("trash");
      await page.locator(`[data-creative-asset="${slides.id}"]`).first().click();
      dialog = page.locator("dialog.creative-asset-dialog[open]");
      await dialog.locator("button[type=submit]").click();
      await dialog.waitFor({ state: "hidden" });
      await ready();
      await page.locator("[data-creative-filter=slides]").click();
      await ready();
      await page.locator(`[data-creative-asset="${slides.id}"]`).first().waitFor();
      assert.equal(await page.locator(".creative-card[data-creative-kind=web]").count(), 0);
      const controls = await page
        .locator(".creative-filters button,[data-creative-import]")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
      assert.ok(
        controls.every((h) => h >= (width < 768 ? 44 : 40)),
        JSON.stringify(controls),
      );
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 1050 });
        await snap("narrow");
      }
      assert.equal(outsideRequests, 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Authored file import, static preview isolation, original downloads, independent project copies, version replacement, typed filters and trash/restore verified on PC/H5.",
  );
} finally {
  outside.stop(true);
  await app.dispose();
}
