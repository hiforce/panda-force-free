import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { collectAssets, publishAssets, writeCdnOutput } from "../../scripts/cdn/publish.mjs";

const fixturePassword = "Fixture-" + randomBytes(24).toString("hex") + "!9a";

const temporary = mkdtempSync(join(tmpdir(), "panda-cdn-browser-"));
const objects = new Map();
const cdnOrigin = "https://static.example.test";
const app = await createAppFixture({
  freshAdministrator: true,
  applicationCreation: true,
  extraEnvironment: () => ({ PANDA_FORCE_REQUIRE_CDN: "false", PANDA_FORCE_CDN_BASE_URL: "" }),
});
app.legacyProject({ name: "CDN fixture", code: "cdn-fixture" });
const screenshots = ".artifacts/cdn-browser";
mkdirSync(screenshots, { recursive: true });
const results = [];
const browsers = [];
try {
  const assets = new Map(collectAssets("public"));
  assets.set("/cdn-retry.js", Buffer.from('export const recovered = "retry-loaded";'));
  assets.set(
    "/cdn-retry-entry.js",
    Buffer.from('export const load = (retry) => retry ? import("/cdn-retry.js?retry=1") : import("/cdn-retry.js");'),
  );
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
    const width = engine === webkit ? 390 : 1440;
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await context.addInitScript(() => {
      globalThis.__pandaForceTest = true;
    });
    const status = await (await context.request.get(app.base + "/api/auth/status")).json();
    const authentication = await context.request.post(
      app.base + (status.setupRequired ? "/api/auth/setup" : "/api/auth/login"),
      { data: { username: "cdn-fixture", password: fixturePassword } },
    );
    assert.ok(authentication.ok(), "Isolated CDN fixture authentication succeeded");
    assert.ok(
      (
        await context.request.post(app.base + "/api/system/database/selection", {
          data: { driver: "sqlite" },
          headers: { Origin: app.base },
        })
      ).ok(),
    );
    await context.addInitScript(() => {
      if (window === window.top && /^https?:$/.test(location.protocol)) {
        if (!localStorage.getItem("panda-force-locale")) localStorage.setItem("panda-force-locale", "zh-CN");
      }
    });
    let retryPrimaryRejected = false;
    await context.route(cdnOrigin + "/**", (route) => {
      const url = new URL(route.request().url());
      if (
        url.pathname === new URL(manifest.assets["/cdn-retry.js"].url).pathname &&
        !url.search &&
        !retryPrimaryRejected
      ) {
        retryPrimaryRejected = true;
        return route.abort("failed");
      }
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
    await page.route(app.base + "/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return /^\/(?:workspace|bots|tasks|projects|create|skills|publish)?$/.test(path)
        ? route.fulfill({ contentType: "text/html", body: readFileSync(join(output, "index.html")) })
        : route.continue();
    });
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
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt:visible").waitFor();
    await page.screenshot({ path: `${screenshots}/workspace-${width}.png` });
    for (const path of ["/http-client.js", "/gadget-document.bundle.js"])
      assert.ok(requests.includes(manifest.assets[path].url), "Required module loaded from CDN: " + path);
    for (const route of ["bots", "tasks", "projects", "create", "skills", "publish"]) {
      await page.goto(app.base + "/" + route);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator("#workbenchView h1:visible").first().waitFor();
      if (route === "create") await page.locator("#gadgetDocumentPrompt:visible").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt:visible").waitFor();
    const retry = await page.evaluate(async (url) => {
      const module = await import(url);
      let initialFailed = false;
      try {
        await module.load(false);
      } catch {
        initialFailed = true;
      }
      return { initialFailed, recovered: (await module.load(true)).recovered };
    }, manifest.assets["/cdn-retry-entry.js"].url);
    assert.deepEqual(retry, { initialFailed: true, recovered: "retry-loaded" });
    assert.ok(requests.includes(manifest.assets["/cdn-retry.js"].url + "?retry=1"));
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
    results.push({
      engine: engine.name(),
      width,
      applicationOriginStaticRequests: 0,
      requiredModules: ["http-client.js", "gadget-document.bundle.js"],
      featureRoutes: 7,
      retryStayedOnCdn: true,
      apiStayedOnOrigin: true,
    });
    console.log(
      `${engine.name()}: workspace, language pack, CSS and lazy modules loaded from CDN; API stays on application origin`,
    );
    await context.close();
  }
  const localBrowser = await chromium.launch({ headless: true });
  browsers.push(localBrowser);
  const localContext = await localBrowser.newContext();
  assert.ok(
    (
      await localContext.request.post(app.base + "/api/auth/login", {
        data: { username: "cdn-fixture", password: fixturePassword },
      })
    ).ok(),
  );
  const localPage = await localContext.newPage(),
    localRequests = [];
  localPage.on("request", (request) => localRequests.push(request.url()));
  await localPage.goto(app.base + "/workspace");
  await localPage.locator("#gadgetDocumentPrompt:visible").waitFor();
  for (const path of ["/http-client.js", "/gadget-document.bundle.js"])
    assert.ok(
      localRequests.some((url) => new URL(url).origin === new URL(app.base).origin && new URL(url).pathname === path),
    );
  assert.ok(localRequests.every((url) => new URL(url).origin !== cdnOrigin));
  results.push({ engine: "chromium", mode: "default-local", externalCdnRequests: 0, requiredModulesLocal: true });
  await localContext.close();
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await app.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
writeFileSync(screenshots + "/results.json", JSON.stringify(results, null, 2));
