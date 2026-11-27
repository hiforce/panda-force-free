import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const f = await createAppFixture(),
  out = ".artifacts/project-overview-loading",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    let release;
    try {
      await f.signIn(context);
      const snapshot = f.legacyProject({ code: "overview-" + width, name: "Project overview " + width });
      const project = snapshot.projects.find((p) => p.code === "overview-" + width);
      const page = await context.newPage(),
        errors = [],
        reads = new Map();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const u = new URL(request.url());
        if (
          ["/api/project-document-tree", "/api/creative-assets", "/api/creative-assets/capabilities"].includes(
            u.pathname,
          ) &&
          u.searchParams.get("project") === project.id
        )
          reads.set(u.pathname, (reads.get(u.pathname) || 0) + 1);
      });
      const gate = new Promise((resolve) => (release = resolve));
      await context.route("**/content-workspace.bundle.js*", async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto(f.base + "/project?id=" + project.id);
      await page.locator("[data-creative-heading]").filter({ hasText: project.name }).waitFor();
      await waitFor(() => reads.size === 3);
      assert.equal(await page.locator(".project-overview-placeholders").isVisible(), true);
      await page.screenshot({ path: `${out}/loading-${width}.png` });
      release();
      await page.locator(".project-gallery-empty").waitFor();
      assert.equal(
        [...reads.values()].every((count) => count === 1),
        true,
        "Mount must reuse initial reads",
      );
      assert.equal(await page.locator("[data-system-composer]").isVisible(), false);
      assert.equal(
        await page.locator(width <= 700 ? "#projectCreationCategory" : ".project-creation-categories").isVisible(),
        true,
      );
      const buttons = page.locator("[data-creative-new]");
      assert.equal(await buttons.isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/empty-${width}.png` });
      await page.locator(".project-create-menu > summary").click();
      await buttons.click();
      await page.locator("#documentTitle").waitFor();
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        identityBeforeCode: true,
        overlappedReads: true,
        noDuplicateReads: true,
        clearEmptyState: true,
        manualCreate: true,
        noHorizontalOverflow: true,
      });
    } finally {
      release?.();
      await context.unrouteAll({ behavior: "wait" });
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await f.dispose();
}
