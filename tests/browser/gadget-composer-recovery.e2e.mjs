import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/gadget-composer-repair";
await mkdir(out, { recursive: true });
const app = await createAppFixture();
const projects = app.legacyProject({ name: "Product research", code: "product-research" }).projects;
const project = projects[0];
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await app.signIn(context);
  await context.request.post(app.base + "/api/system/database/selection", {
    data: { driver: "sqlite" },
    headers: { Origin: app.base },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  let release;
  const transfer = new Promise((resolve) => {
    release = resolve;
  });
  let warmed = 0,
    reads = 0,
    submissions = 0;
  await page.route("**/gadget-document.bundle.js*", async (route) => {
    warmed++;
    await transfer;
    await route.continue();
  });
  await page.route("**/api/creative-assets/capabilities?*", async (route) => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ status: 200, json: { contribute: false } });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/document-creations$/.test(new URL(request.url()).pathname)) submissions++;
  });
  await page.goto(app.base);
  await page.locator("[data-gw=customize]:enabled").waitFor();
  await page.locator('[data-gadget-type-id="system.composer"] [role="status"]').waitFor();
  await page.locator('[data-wb="route"][data-route="tasks"]:visible').first().click();
  release();
  assert.equal(await page.locator(".gadget-document-form").count(), 0);
  await page.locator('[data-wb="route"][data-route="workspace"]:visible').first().click();
  await page.locator("[data-gd-skills]:enabled").waitFor();
  assert(warmed >= 1);
  assert.equal(reads, 0);
  await page.locator("#gadgetDocumentPrompt").fill("Preserve my brief when changing the destination");
  await page.locator("[data-gd-project]").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.match(await page.locator("[data-gd-project]").innerText(), /Product research/);
  assert.equal(
    await page.locator("#gadgetDocumentPrompt").inputValue(),
    "Preserve my brief when changing the destination",
  );
  await page.locator("[data-gd-skills]").click();
  const skillPicker = page.locator(".creation-skill-browser[open]");
  await skillPicker.locator("[data-skill-id=software-prd]").click();
  await skillPicker.locator("footer [data-skill-browser-close]").click();
  await page.evaluate(() => {
    const form = document.querySelector(".gadget-document-form");
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.waitForFunction(() => document.querySelector("[data-gd-start]")?.getAttribute("aria-busy") === "false");
  assert.equal(reads, 1, "Repeated submits share one permission check");
  assert.equal(submissions, 0);
  assert.equal(await page.locator("[data-gd-retry]").isVisible(), false);
  assert.equal(
    await page.locator("[data-gd-notice]").innerText(),
    "You cannot create documents here. Choose another destination.",
  );
  assert(await page.locator("[data-gd-skills]").isEnabled());
  await page.locator("[data-gd-skills]").click();
  await page.locator(".creation-skill-browser[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("[data-gd-project]").click();
  await page.screenshot({ path: out + "/project-menu-desktop.png" });
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 390, height: 844 });
  // Let the existing responsive drawer transition settle before visual review.
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "aurora";
  });
  await page.locator("[data-gd-project]").click();
  const bounds = await page.locator(".gadget-document-destinations.floating-menu").boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: out + "/project-menu-mobile.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/recovery-results.json",
    JSON.stringify(
      {
        passed: true,
        project: !!project,
        permissionDeniedBlocksSubmission: true,
        reads,
        submissions,
        staleModuleCannotMountAfterNavigation: true,
        destinationKeepsBrief: true,
        keyboard: true,
        mobile: true,
      },
      null,
      2,
    ),
  );
  console.log("Composer loading, destination and permission recovery passed.");
} finally {
  await browser.close();
  await app.dispose();
}
