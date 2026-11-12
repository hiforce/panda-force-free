import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { collectAssets, publishAssets, writeCdnOutput } from "../../scripts/cdn/publish.mjs";

const temporary = mkdtempSync(join(tmpdir(), "panda-cdn-browser-"));
const objects = new Map();
const cdnOrigin = "https://static.example.test";
const app = await createAppFixture({ freshAdministrator: true });
const browsers = [];
try {
  const assets = new Map(collectAssets("public"));
  // Vendor fonts and CSS are served from their installed package during local builds.
  for (const [source, prefix] of [
    ["node_modules/katex/dist", "/vendor/katex"],
    ["node_modules/@xterm/xterm/css", "/vendor/xterm"],
  ]) {
    for (const [path, bytes] of collectAssets(source).filter(([path]) => !path.endsWith(".md")))
      assets.set(prefix + path, bytes);
  }
  const manifest = await publishAssets({
    assets,
    baseUrl: cdnOrigin,
    verify: async (url, bytes) => assert.deepEqual(objects.get(new URL(url).pathname.slice(1))?.bytes, bytes),
    prefix: "app/static",
    storage: {
      get: async (key) => objects.get(key)?.bytes || null,
      put: async (key, bytes, type) => objects.set(key, { bytes, type }),
    },
  });
  const output = join(temporary, "public");
  writeCdnOutput({ source: "public", output, manifest });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    await context.addInitScript(() => {
      globalThis.__pandaForceTest = true;
    });
    const status = await (await context.request.get(app.base + "/api/auth/status")).json();
    const authentication = await context.request.post(
      app.base + (status.setupRequired ? "/api/auth/setup" : "/api/auth/login"),
      { data: { username: "cdn-fixture", password: "CdnFixture12345" } },
    );
    assert.ok(authentication.ok(), "Isolated CDN fixture authentication succeeded");
    await context.addInitScript(() => {
      if (window === window.top && /^https?:$/.test(location.protocol))
        localStorage.setItem("panda-force-locale", "zh-CN");
    });
    await context.route(cdnOrigin + "/**", (route) => {
      const object = objects.get(new URL(route.request().url()).pathname.slice(1));
      return object
        ? route.fulfill({
            body: object.bytes,
            headers: { "content-type": object.type, "access-control-allow-origin": "*" },
          })
        : route.fulfill({ status: 404, body: "Missing" });
    });
    const page = await context.newPage(),
      errors = [],
      requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.route(app.base + "/", (route) =>
      route.fulfill({ contentType: "text/html", body: readFileSync(join(output, "index.html")) }),
    );
    await page.goto(app.base + "/");
    try {
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.connected === true, null, {
        timeout: 15000,
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          engine: engine.name(),
          errors,
          requests,
          text: (await page.locator("body").innerText()).slice(0, 600),
        }),
      );
      throw error;
    }
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    await page.evaluate(async (urls) => {
      await document.fonts.load("16px KaTeX_Main");
      await import(urls["/file-preview.bundle.js"].url);
      await import(urls["/terminal-runtime.bundle.js"].url);
    }, manifest.assets);
    assert.ok(requests.includes(manifest.assets["/app.bundle.js"].url));
    assert.ok(requests.includes(manifest.assets["/locales/zh-CN.json"].url));
    assert.ok(requests.includes(manifest.assets["/vendor/katex/katex.min.css"].url));
    assert.ok(requests.includes(manifest.assets["/vendor/xterm/xterm.css"].url));
    assert.ok(
      requests.some((url) => /\.(?:woff2?|ttf)$/.test(new URL(url).pathname)),
      "CDN font requested",
    );
    for (const url of requests) {
      const path = new URL(url).pathname;
      assert.ok(
        !(new URL(url).origin === new URL(app.base).origin && manifest.assets[path]),
        "Static resource escaped CDN: " + path,
      );
      if (path.startsWith("/api/")) assert.equal(new URL(url).origin, new URL(app.base).origin);
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: workspace, language pack, CSS and lazy modules loaded from CDN; API stays on application origin`,
    );
    await context.close();
  }
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await app.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
