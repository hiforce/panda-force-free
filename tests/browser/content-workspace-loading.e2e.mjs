import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture(),
  out = ".artifacts/content-workspace-loading";
await mkdir(out, { recursive: true });
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        colorScheme: width === 1440 ? "light" : "dark",
      });
    let release;
    try {
      await fixture.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      let requests = 0,
        blocked = false;
      const pending = new Promise((resolve) => (release = resolve));
      await context.route("**/content-workspace.bundle.js*", async (route) => {
        requests++;
        if (requests === 1) {
          await route.fulfill({ status: 503, contentType: "text/plain", body: "Isolated transfer failure" });
          return;
        }
        if (!blocked) {
          blocked = true;
          await pending;
        }
        await route.continue();
      });
      await page.goto(fixture.base + "/tasks");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      assert.equal(requests, 0, "Session startup must not load optional content workspaces");
      const navigate = async (name) => page.locator(`[data-wb="route"][data-route="${name}"]:visible`).first().click();
      await navigate("create");
      await page.locator("[data-content-workspace-retry]").waitFor();
      assert.match(
        await page.locator("[data-content-workspace-status]").innerText(),
        locale === "en" ? /couldn’t load/ : /无法加载/,
      );
      await page.locator("[data-content-workspace-retry]").click();
      await waitFor(() => blocked);
      await navigate("tasks");
      await page.waitForURL("**/tasks");
      release();
      await waitFor(() => requests >= 3);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(await page.locator(".creative-workspace").count(), 0, "A late module replaced the new route");
      await navigate("create");
      await page.locator(".creative-workspace").waitFor();
      const draft = page.locator("#gadgetDocumentPrompt");
      await draft.fill("Preserve my active draft across an unrelated route refresh.");
      await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(await draft.inputValue(), "Preserve my active draft across an unrelated route refresh.");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/loaded-${width}.png` });
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        notLoadedDuringSessionStartup: true,
        transferFailureRetry: true,
        lateModuleDoesNotReviveRoute: true,
        cachedReturnWorks: true,
        rerenderPreservesDraft: true,
        noHorizontalOverflow: true,
      });
    } finally {
      release?.();
      await context.unrouteAll({ behavior: "wait" });
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/result.json",
    JSON.stringify({ passed: true, records, modelInferenceRequested: false }, null, 2) + "\n",
  );
} finally {
  await fixture.dispose();
}
