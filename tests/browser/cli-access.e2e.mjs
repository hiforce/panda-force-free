import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  out = ".artifacts/cli-access";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width, height: 1100 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
    try {
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let failedModule = false;
      if (width === 1440)
        await page.route("**/settings-pages.bundle.js", (route) => {
          if (failedModule) return route.continue();
          failedModule = true;
          return route.fulfill({ status: 503, body: "Temporarily unavailable" });
        });
      const navigate = async (path) => {
        if (width < 700 && (await page.locator(".settings-mobile-back:visible").count()))
          await page.locator(".settings-mobile-back:visible").first().click();
        await page
          .locator("[data-settings-group]")
          .evaluateAll((groups) => groups.forEach((group) => (group.open = true)));
        await page.locator(`[data-settings-page="${path.split("/").at(-1)}"]`).click();
      };
      let releaseModule;
      if (width === 390) {
        let held = false;
        const gate = new Promise((resolve) => {
          releaseModule = resolve;
        });
        await page.route("**/settings-pages.bundle.js", async (route) => {
          if (!held) {
            held = true;
            await gate;
          }
          return route.continue();
        });
      }
      const moduleRequested = width === 390 ? page.waitForRequest("**/settings-pages.bundle.js") : null;
      await page.goto(app.base + "/settings/client-access", { waitUntil: "domcontentloaded" });
      if (width === 390) {
        await moduleRequested;
        await navigate("/settings/general-settings");
        await page.locator('[data-settings-content="general-settings"]').waitFor();
        releaseModule();
        await page.evaluate(async () => {
          await import("/settings-pages.bundle.js");
        });
        assert.equal(
          await page.locator("[data-cli-form]").count(),
          0,
          "A late module must not mount a closed settings page",
        );
        await navigate("/settings/client-access");
      }
      if (width === 1440) {
        const retry = page.locator('[data-settings-view="client-access"] button');
        await retry.waitFor();
        assert.ok(failedModule);
        await retry.click();
      }
      await page
        .locator("[data-cli-form]")
        .waitFor()
        .catch(async (error) => {
          console.log("Client settings page errors", errors);
          await page.screenshot({ path: `${out}/failure-${width}.png`, fullPage: true });
          throw error;
        });
      const form = page.locator("[data-cli-form]");
      await form.locator('[name="pf-cli-name"]').fill("Agent " + width);
      await form.locator("details summary").click();
      await form.locator('[name="pf-cli-kind"]').selectOption(width < 700 ? "claude" : "codex");
      const issuedResponse = page.waitForResponse(
        (response) => response.url().endsWith("/api/cli/clients") && response.request().method() === "POST",
      );
      await form.locator('button[type="submit"]').click();
      const response = await issuedResponse;
      assert.equal(response.status(), 201);
      const issued = await response.json();
      assert.equal(issued.projectScope, "allAccessible");
      assert.deepEqual(issued.projects, []);
      await page.locator("[data-cli-secret]").waitFor({ state: "visible" });
      assert.equal(await page.locator("[data-cli-key]").getAttribute("type"), "password");
      assert.equal(await page.locator("[data-cli-key]").inputValue(), issued.apiKey);
      assert.equal(await form.locator('[name="pf-cli-capability"][value="knowledge:approve"]').isChecked(), false);
      assert.equal(await form.locator('[name="pf-cli-capability"][value="knowledge:write"]').isChecked(), false);
      const download = page.waitForEvent("download");
      await page.locator("[data-cli-download]").click();
      const file = await download,
        stream = await file.createReadStream(),
        chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const registration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(registration, issued.registration);
      assert.ok(!JSON.stringify(registration).includes(issued.apiKey));
      await page.locator("[data-cli-done]").click();
      assert.equal(await page.locator("[data-cli-key]").inputValue(), "");
      assert.equal(await page.locator("[data-cli-secret]").isVisible(), false);
      await form.locator('[name="pf-cli-name"]').fill("Cached client " + width);
      const secondIssue = page.waitForResponse(
        (response) => response.url().endsWith("/api/cli/clients") && response.request().method() === "POST",
      );
      await form.locator('button[type="submit"]').click();
      assert.equal((await secondIssue).status(), 201);
      await page.locator("[data-cli-secret]").waitFor({ state: "visible" });
      await navigate("/settings/general-settings");
      await page.locator('[data-settings-content="general-settings"]').waitFor();
      assert.equal(
        await page.locator("[data-cli-key]").count(),
        0,
        "Leaving must clear the one-time key before a cached page can reopen",
      );
      await navigate("/settings/client-access");
      await page.locator("[data-cli-form]").waitFor();
      assert.equal(await page.locator("[data-cli-secret]").isVisible(), false);
      assert.equal(await page.locator('[name="pf-cli-name"]').inputValue(), "Panda CLI");
      await page.reload();
      await page.locator("[data-cli-form]").waitFor();
      assert.equal(await page.locator("[data-cli-secret]").isVisible(), false);
      await page
        .locator("[data-cli-clients]")
        .getByText("Agent " + width, { exact: true })
        .waitFor();
      await page.screenshot({ path: `${out}/settings-${width}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const noKey = await fetch(app.base + "/api/cli/v1/session");
      assert.equal(noKey.status, 401);
      await noKey.body.cancel();
      const headers = {
        authorization: "Bearer " + issued.apiKey,
        "x-panda-client-id": issued.registration.clientId,
        "x-panda-cli-protocol": "1",
      };
      assert.equal((await fetch(app.base + "/api/cli/v1/session", { headers })).status, 200);
      await page.locator(`[data-cli-revoke="${issued.registration.clientId}"]`).click();
      await page.locator(`[data-cli-revoke="${issued.registration.clientId}"]`).waitFor({ state: "detached" });
      assert.equal((await fetch(app.base + "/api/cli/v1/session", { headers })).status, 401);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Registered Codex/Claude clients, private one-time key, registration export, PC/H5 layout and server revocation verified.",
  );
} finally {
  await app.dispose();
}
