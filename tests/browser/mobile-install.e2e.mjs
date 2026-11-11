import assert from "node:assert/strict";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
import { BRAND_ASSET_VERSION } from "../../src/shared/brand.js";
import { LAUNCH_SCREENS } from "../../src/shared/install-assets.js";
import { localAuthFixture } from "../support/local-auth-fixture.mjs";

const fixture = await localAuthFixture();
let browser;
try {
  const manifestResponse = await fetch(fixture.base + "/manifest.webmanifest");
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type"), /application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/workspace");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.id, "/");
  const icons = [...manifest.icons, { src: "/assets/panda-touch-180.png", sizes: "180x180" }];
  for (const icon of icons) {
    const response = await fetch(fixture.base + icon.src);
    assert.equal(response.status, 200, "Installation assets must be accessible before sign-in");
    assert.match(response.headers.get("content-type"), /image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes);
    assert.equal(metadata.hasAlpha, false, "Home Screen icons have an opaque background");
  }
  for (const screen of LAUNCH_SCREENS) {
    const response = await fetch(fixture.base + screen.path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/png/);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(metadata.width, screen.width);
    assert.equal(metadata.height, screen.height);
    assert.equal(metadata.hasAlpha, false);
  }
  assert.equal((await fetch(fixture.base + "/app.bundle.js")).status, 401);
  browser = await (process.env.PANDA_FORCE_TEST_BROWSER === "webkit" ? webkit : chromium).launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseBootstrap;
  const bootstrap = new Promise((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route("**/auth-bootstrap.js", async (route) => {
    await bootstrap;
    await route.continue();
  });
  let statusRequested = false,
    localeRequested = false,
    releaseStartup;
  const startup = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  await page.route("**/api/auth/status", async (route) => {
    statusRequested = true;
    await startup;
    await route.continue();
  });
  await page.route("**/locales/zh-CN.json*", async (route) => {
    localeRequested = true;
    await startup;
    await route.continue();
  });
  await page.goto(fixture.base, { waitUntil: "commit" });
  await page.locator("#startupScreen").waitFor({ state: "visible" });
  assert.equal(await page.locator("#startupScreen strong").textContent(), "PandaForce");
  assert.equal(await page.locator("#app").isVisible(), false);
  assert.equal(await page.locator("#passwordGate").isVisible(), false);
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content"), "yes");
  assert.equal(
    await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
    `/assets/panda-touch-180.png?v=${BRAND_ASSET_VERSION}`,
  );
  assert.equal(await page.locator('link[rel="apple-touch-startup-image"]').count(), LAUNCH_SCREENS.length);
  const phoneScreen = LAUNCH_SCREENS.find(
    (screen) => screen.width === 1290 && screen.height === 2796 && screen.theme === "dark",
  );
  assert.ok(phoneScreen, "The reported phone resolution has a dedicated launch image");
  assert.equal(
    await page.locator(`link[href="${phoneScreen.path}?v=${BRAND_ASSET_VERSION}"]`).getAttribute("media"),
    phoneScreen.media,
  );
  releaseBootstrap();
  await page.waitForFunction(() =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes("/auth-bootstrap.js")),
  );
  const deadline = Date.now() + 10000;
  while ((!statusRequested || !localeRequested) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(statusRequested && localeRequested, "Authentication and localization start independently");
  assert.equal(await page.locator("#startupScreen").isVisible(), true);
  await page.screenshot({ path: artifact("home-screen-startup.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(
    await page.locator("#startupScreen progress").evaluate((node) => getComputedStyle(node).accentColor),
    "rgb(255, 64, 87)",
  );
  await page.screenshot({ path: artifact("home-screen-startup-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });

  releaseStartup();
  await page.locator("#passwordGate").waitFor({ state: "visible" });
  await page.locator("#startupScreen").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#passwordTitle").textContent(), "创建管理员账号");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const failure = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en" });
  await failure.route("**/api/auth/status", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await failure.goto(fixture.base);
  await failure.locator("#authRetryButton").waitFor({ state: "visible" });
  assert.equal(await failure.locator("#startupScreen").isVisible(), false);
  assert.equal(await failure.locator("#app").isVisible(), false);
  assert.equal(
    await failure
      .locator("#authRetryButton")
      .textContent()
      .then((value) => value.trim()),
    "Retry",
  );

  const offline = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await offline.goto(fixture.base);
  assert.equal(await offline.locator("#startupScreen").isVisible(), true);
  assert.match(await offline.locator("noscript").textContent(), /JavaScript is required/);
  assert.equal(await offline.locator(".startup-recovery").getAttribute("href"), "");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      anonymousInstallAssets: true,
      opaqueIcons: true,
      firstPaintBeforeJavaScript: true,
      parallelStartup: true,
      localizedTransition: true,
      authFailureRetry: true,
      noScriptFeedback: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
