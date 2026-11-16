import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-extension";
await mkdir(out, { recursive: true });
const manifest = {
  id: "test.integration",
  apiVersion: 1,
  version: "1.0.0",
  configVersion: 1,
  title: { en: "Integration widget", "zh-CN": "集成组件", "zh-HK": "整合元件", "zh-TW": "整合元件" },
  description: {
    en: "A registered service and sandboxed UI.",
    "zh-CN": "已注册的服务与隔离界面。",
    "zh-HK": "已註冊的服務與隔離介面。",
    "zh-TW": "已註冊的服務與隔離介面。",
  },
  icon: "newUnknownExtensionIcon",
  source: "extension",
  permissions: ["test.read"],
  singleton: false,
  layout: { w: 4, h: 6, minW: 4, minH: 4 },
  config: { allow: { type: "boolean", default: true } },
  services: ["summary"],
  actions: ["open"],
  minRefreshSeconds: 60,
};
const frontend = `PandaGadget.define((root,initial)=>{let epoch=0;return {async update(context){const n=++epoch;let isolated=false;try{isolated=!parent.document;}catch{isolated=true;}const value=await context.data('summary');if(n!==epoch||context.signal.aborted)return;root.textContent='Service: '+value.total+'; isolated: '+isolated+'; theme: '+context.theme['--pf-ink'];},dispose(){epoch++;}};});`;
const app = await createAppFixture({
  prepareState: async ({ dir }) => {
    await writeFile(
      join(dir, "gadget-module.ts"),
      `export function registerGadgets(registry){registry.register({manifest:${JSON.stringify(manifest)},frontend:${JSON.stringify(frontend)},services:{summary:{authorize:c=>c.config.allow===true,handle:c=>({total:37})}},actions:{open:{authorize:()=>true,handle:()=>({navigate:'/tasks'})}}});registry.register({manifest:{...${JSON.stringify(manifest)},id:"test.broken"},frontend:'PandaGadget.define(()=>({update(){throw Error("fixture");}}));',services:{summary:{authorize:()=>true,handle:()=>({total:0})}},actions:{open:{authorize:()=>true,handle:()=>({})}}});}`,
    );
  },
  extraEnvironment: ({ dir }) => ({ PANDA_FORCE_GADGET_MODULES: JSON.stringify([join(dir, "gadget-module.ts")]) }),
});
const results = [];
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        data: { driver: "sqlite" },
        headers: { Origin: app.base },
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/");
      await page.locator("[data-gw=customize]:enabled").waitFor();
      await page.locator("[data-gw=customize]").click();
      await page.locator("[data-gw=library]:visible").first().click();
      const panel = width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await panel.locator("[data-ge=filter][data-value=extension]").click();
      await panel.locator('[data-ge=add][data-type="test.integration"]').click();
      const widget = page.locator('[data-gadget-type-id="test.integration"]').last();
      await widget.locator("iframe").waitFor();
      await assert.doesNotReject(() =>
        widget.frameLocator("iframe").getByText("Service: 37; isolated: true").waitFor(),
      );
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--pf-ink", "#112233");
        window.dispatchEvent(new CustomEvent("panda-force:appearance-changed"));
      });
      await widget.frameLocator("iframe").getByText("theme: #112233", { exact: false }).waitFor();
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("--pf-ink");
        window.dispatchEvent(new CustomEvent("panda-force:appearance-changed"));
      });
      await widget.locator("[data-gw=config]").click();
      const settings = width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await settings.locator("[data-ge-field=allow]").uncheck();
      if (width < 1050) await settings.locator("[data-ge=close]").click();
      const denied = await context.request.post(app.base + "/api/gadgets/data", {
        data: { gadget: "test.integration", name: "summary", instanceId: "test", config: { allow: false } },
        headers: { Origin: app.base },
      });
      assert.equal(denied.status(), 403);
      await page.locator("[data-gw=library]:visible").first().click();
      const brokenLibrary =
        width < 1050 ? page.locator(".gadget-editor-dialog[open]") : page.locator(".gadget-editor-slot");
      await brokenLibrary.locator("[data-ge=filter][data-value=extension]").click();
      await brokenLibrary.locator('[data-ge=add][data-type="test.broken"]').click();
      const broken = page.locator('[data-gadget-type-id="test.broken"]');
      await broken.locator(".gadget-error [data-gw=retry-widget]").waitFor();
      await page.locator("#gadgetDocumentPrompt").fill("Other widgets remain usable after an extension failure.");
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Other widgets remain usable after an extension failure.",
      );
      await broken.locator("[data-gw=remove]").click();
      if (width >= 1050) {
        await page.locator("[data-gw=library]:visible").first().click();
        await page.locator(".gadget-editor-slot [data-ge=filter][data-value=system]").click();
        const body = page.locator(".gadget-canvas");
        await page.locator('[data-gadget-type="system.bots"]').dragTo(body, { targetPosition: { x: 5, y: 30 } });
        await page.locator('[data-gadget-type-id="system.bots"]').waitFor();
      }
      await page.screenshot({ path: `${out}/extension-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({ width, isolated: true, registeredService: true, forbidden: denied.status(), errors });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
