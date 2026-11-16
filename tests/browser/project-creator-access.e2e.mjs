import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { idaasContentFixture } from "../support/idaas-content-fixture.mjs";
const f = await idaasContentFixture(),
  out = ".artifacts/project-creator-access",
  records = [];
await mkdir(out, { recursive: true });
try {
  const alice = await f.login("alice"),
    bob = await f.login("bob");
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    try {
      const equal = alice.indexOf("=");
      await context.addCookies([
        { name: alice.slice(0, equal), value: alice.slice(equal + 1), url: f.base, httpOnly: true, sameSite: "Lax" },
      ]);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(f.base + "/projects");
      await page.locator('[data-wb="create-project"]').first().click();
      const code = "creator-" + width;
      await page.locator("#projectNameInput").fill("My new project " + width);
      await page.locator("#projectCodeInput").fill(code);
      await page.locator('#projectForm [type="submit"]').click();
      await page.locator("#projectDialog").waitFor({ state: "hidden" });
      const catalog = await (await f.api(alice, "/api/projects")).json(),
        project = catalog.projects.find((p) => p.code === code);
      assert.ok(project);
      await page.waitForURL("**/project?id=" + project.id);
      await page.locator("[data-creative-new]:enabled").waitFor();
      assert.equal(await page.locator("[data-creative-retry]").isVisible(), false);
      assert.notEqual(await page.locator("[data-creative-status]").getAttribute("data-error"), "true");
      assert.equal((await f.api(bob, "/api/project-document-tree?project=" + project.id)).status, 404);
      await page.screenshot({ path: `${out}/new-empty-${width}.png` });
      await page.locator("[data-creative-new]").click();
      await page.locator("#documentTitle").waitFor();
      await page.goto(f.base + "/project?id=" + project.id);
      await page.locator(".creative-card").waitFor();
      await page.reload();
      await page.locator("[data-creative-new]:enabled").waitFor();
      await page.locator(".creative-card").waitFor();
      assert.equal(await page.locator("[data-creative-retry]").isVisible(), false);
      assert.equal(
        (await (await f.api(alice, "/api/project-document-tree?project=" + project.id)).json()).nodes.length,
        1,
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/document-${width}.png` });
      records.push({
        width,
        locale,
        nonAdministratorIdaasCreator: true,
        immediateContentAndCreate: true,
        documentAndReload: true,
        otherAccountDenied: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/verification.json", JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await f.close();
}
