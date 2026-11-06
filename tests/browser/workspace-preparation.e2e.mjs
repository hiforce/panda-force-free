import assert from "node:assert/strict";
import { chromium } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture({ freshAdministrator: true });
let browser;
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ locale: "en", viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    globalThis.__pandaForceTest = true;
  });
  await context.addInitScript(() => {
    if (window === window.top)
      window.WebSocket = class {
        static OPEN = 1;
        constructor() {
          throw new Error("Use the SSE test transport");
        }
      };
  });
  const page = await context.newPage(),
    errors = [],
    held = new Map(),
    seen = new Set();
  let bundle,
    events,
    failSessions = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/app.bundle.js", (route) => {
    bundle = route;
  });
  await page.route("**/api/events*", (route) => {
    if (!events) {
      events = route;
      return;
    }
    return route.continue();
  });
  for (const [path, key] of [
    ["config", "configuration"],
    ["projects/visibility", "projects"],
  ])
    await page.route("**/api/" + path, async (route) => {
      if (seen.has(key)) return route.continue();
      seen.add(key);
      const response = await route.fetch();
      held.set(key, () => route.fulfill({ response }));
    });
  await page.route("**/api/rpc", async (route) => {
    const method = route.request().postDataJSON().method,
      key = { "thread/list": "sessions", "model/list": "models", "permissionProfile/list": "permissions" }[method];
    if (method === "thread/list" && failSessions)
      return route.fulfill({ json: { type: "rpc/error", error: "Session list unavailable" } });
    if (!key || seen.has(key)) return route.continue();
    seen.add(key);
    const response = await route.fetch();
    held.set(key, () => route.fulfill({ response }));
  });
  await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
  const publicLogo = await context.request.get(fixture.base + "/assets/panda-mark.svg");
  assert.equal(publicLogo.status(), 200);
  assert.match(publicLogo.headers()["content-type"], /image\/svg\+xml/);
  await page.getByRole("heading", { name: "Create your administrator", exact: true }).waitFor();
  assert.equal(await page.locator("#workspacePreparation").isVisible(), false);
  assert.equal(
    await page.locator(".auth-account-note").textContent(),
    "Your PandaForce account is separate from your Codex account.",
  );
  await page.locator("#usernameInput").fill("owner");
  await page.locator("#passwordInput").fill("Abc123");
  await page.locator("#passwordConfirmInput").fill("Abc123");
  await page.locator("#passwordLoginButton").click();
  await page.locator("#workspacePreparation").waitFor({ state: "visible" });
  await waitFor(() => bundle);
  assert.equal(await page.evaluate(() => Boolean(globalThis.__pandaForceDebug)), false);
  await bundle.continue();
  await page.unroute("**/app.bundle.js");
  await page.waitForFunction(() => globalThis.__pandaForceDebug);
  await waitFor(() => held.has("configuration") && held.has("projects") && held.has("models") && events);
  await page.waitForFunction(() => document.querySelector("#workspacePreparationProgress").value === 1);
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#workspacePreparationProgress").evaluate((p) => p.value), 1);
  assert.equal(await page.locator("#app").isVisible(), false);
  assert.equal(await page.locator("#app").evaluate((el) => el.inert), true);
  const bounds = await page.locator("#workspacePreparation").boundingBox();
  assert.equal(bounds.x, 0);
  assert.equal(bounds.width, 1280);
  await page.waitForFunction(() => {
    const logo = document.querySelector(".workspace-preparation-logo");
    return logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0;
  });
  const brand = await page.locator(".workspace-preparation-banner").boundingBox();
  const title = await page.locator("#workspacePreparationTitle").boundingBox();
  assert.ok(brand.y + brand.height < title.y);
  assert.match(await page.locator(".workspace-preparation-banner").innerText(), /PandaForce/);
  await page.screenshot({ path: artifact("workspace-preparation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  await page.getByRole("heading", { name: "正在准备工作台", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: artifact("workspace-preparation-mobile.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: artifact("workspace-preparation-mobile-dark.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator(".workspace-preparation-logo").scrollIntoViewIfNeeded();
  const smallLogo = await page.locator(".workspace-preparation-logo").boundingBox();
  assert.ok(smallLogo.x >= 0 && smallLogo.y >= 0 && smallLogo.x + smallLogo.width <= 320);
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const key of ["configuration", "projects", "models"]) await held.get(key)();
  await page.waitForFunction(() => document.querySelector("#workspacePreparationProgress").value === 4);
  await events.continue();
  await page.unroute("**/api/events*");
  await waitFor(() => held.has("sessions") && held.has("permissions"));
  await held.get("sessions")();
  await page.locator('.thread-item[data-id="old-alpha"]').waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector("#workspacePreparationProgress").value === 6);
  assert.equal(await page.locator("#workspacePreparation").isVisible(), true);
  await held.get("permissions")();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#app").isVisible(), true);
  assert.equal(await page.locator("#app").evaluate((el) => el.inert), false);
  // A failed read remains actionable and never reports that all preparation succeeded.
  failSessions = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#workspacePreparation")?.dataset.status === "error");
  assert.equal(await page.locator("#workspacePreparationReload").isVisible(), true);
  assert.ok(await page.locator("#workspacePreparationProgress").evaluate((p) => p.value < p.max));
  await page.locator("#workspacePreparationContinue").click();
  assert.equal(await page.locator("#workspacePreparation").isVisible(), false);
  failSessions = false;
  await page.route("**/app.bundle.js", (route) => route.abort("failed"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector('#workspacePreparation [data-step="interface"]')?.dataset.status === "error",
  );
  assert.equal(await page.locator("#workspacePreparationReload").isVisible(), true);
  assert.equal(await page.locator("#workspacePreparationContinue").isDisabled(), true);
  await page.unroute("**/app.bundle.js");
  await page.locator("#workspacePreparationReload").click();
  await page.locator('.thread-item[data-id="old-alpha"]').waitFor();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      firstLoginProgress: true,
      bundleLoadingVisible: true,
      realCompletedSteps: true,
      shellHiddenUntilReady: true,
      localized: true,
      mobileAndDark: true,
      failedReadsActionable: true,
      failedBundleReload: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
