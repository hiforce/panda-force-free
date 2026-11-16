import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createDatabaseUiFixture, waitForDatabaseUi as waitFor } from "../support/database-ui-fixture.mjs";
const out = ".artifacts/mysql-integration/database-ui";
await mkdir(out, { recursive: true });
const app = await createDatabaseUiFixture(),
  records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    try {
      await context.addInitScript((locale) => {
        if (window === top && /^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let administrator = false,
        initialChoiceRequired = true,
        operation = null,
        cancels = 0,
        planRequests = 0,
        migrationRequests = 0;
      const recovery = { id: "f054d0e0-5ce0-4bc4-a3bb-a57b1fc414e4", statusToken: "A".repeat(43) },
        source = { driver: "sqlite" },
        target = { driver: "mysql", hostname: "db-boundary.internal", database: "database_boundary" };
      const overview = () => ({
        schema: 1,
        administrator,
        initialChoiceRequired,
        current: source,
        readiness: { ready: true, modules: [], issues: [] },
        ...(operation ? { operation } : {}),
      });
      await page.route("**/api/system/database**", async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname.slice("/api/system/database".length);
        const json = (body, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (path === "") return json(overview());
        if (path === "/plan") {
          planRequests++;
          return json({
            id: "expires-before-submit",
            source,
            target,
            restartRequired: true,
            ready: true,
            modules: [],
            issues: [],
            expiresAt: Date.now() + 60000,
          });
        }
        if (path === "/migrate") {
          migrationRequests++;
          return json({ error: { code: "migrationPlanExpired" } }, 409);
        }
        if (path === `/operations/${operation?.id}`) {
          assert.equal(request.headers()["x-panda-database-operation"], recovery.statusToken);
          return json(operation);
        }
        if (path === `/operations/${operation?.id}/cancel`) {
          cancels++;
          assert.equal(request.headers()["x-panda-database-operation"], recovery.statusToken);
          operation = { ...operation, status: "canceled", stage: "canceled", canCancel: false, canRetry: false };
          return route.abort("failed");
        }
        throw Error("Unexpected request " + path);
      });
      await page.goto(app.base + "/settings/storage");
      const panel = page.locator("[data-database-settings]");
      await panel.waitFor();
      await waitFor(async () => await panel.innerText().then((s) => /administrator|管理員/.test(s)));
      assert.equal(await page.locator("[data-database-setup]").count(), 0);
      assert.equal(await panel.locator("[data-database-form]").count(), 0);
      await page.screenshot({ path: `${out}/managed-${locale}-${width}.png` });
      administrator = true;
      initialChoiceRequired = false;
      await page.reload();
      await panel.locator("[data-database-form]").waitFor();
      assert.equal(await page.locator("[data-database-setup]").count(), 0);
      for (const [key, value] of Object.entries({
        hostname: target.hostname,
        database: target.database,
        username: "database_boundary_user",
        password: "boundary-password",
      }))
        await panel.locator(`[data-database-field="${key}"]`).fill(value);
      await panel.locator("[data-database-review]").click();
      await panel.locator("[data-database-migrate]").click();
      await panel.locator("[data-database-form]").waitFor({ state: "visible" });
      assert.equal(await panel.locator('[data-database-field="hostname"]').inputValue(), target.hostname);
      assert.equal(await panel.locator('[data-database-field="password"]').inputValue(), "boundary-password");
      assert.equal(
        await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("panda-database-operation:"))),
        false,
      );
      assert.equal(planRequests, 1);
      await panel.locator("[data-database-review]").click();
      await page.evaluate(() => {
        window.__databaseOriginalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("panda-database-operation:"))
            throw new DOMException("Storage blocked", "QuotaExceededError");
          return window.__databaseOriginalSet.call(this, key, value);
        };
      });
      await panel.locator("[data-database-migrate]").click();
      await waitFor(async () => !(await panel.locator("[data-database-migrate]").isDisabled()));
      assert.equal(migrationRequests, 1);
      assert.equal(
        await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("panda-database-operation:"))),
        false,
      );
      await page.evaluate(() => {
        Storage.prototype.setItem = window.__databaseOriginalSet;
        delete window.__databaseOriginalSet;
      });

      operation = {
        id: recovery.id,
        status: "failed",
        stage: "failed",
        source,
        target,
        modules: [{ module: "documents", stage: "verify", rows: 5 }],
        startedAt: Date.now(),
        updatedAt: Date.now(),
        canRetry: false,
        canCancel: false,
        error: { code: "migrationFailed" },
      };
      await page.evaluate(
        (value) =>
          sessionStorage.setItem(
            "panda-database-operation:" + globalThis.__pandaForceIdentityKey,
            JSON.stringify(value),
          ),
        recovery,
      );
      await page.reload();
      await panel.locator("[data-database-result]").waitFor();
      assert.equal(await panel.locator("[data-database-retry]").count(), 0);
      assert.equal(await panel.locator("[data-database-cancel]").count(), 0);
      operation.canCancel = true;
      await panel.locator("[data-database-recover]").click();
      await panel.locator("[data-database-cancel]").waitFor();
      await panel.locator("[data-database-cancel]").click();
      await panel.locator("[data-database-done]").waitFor();
      assert.equal(cancels, 1);
      await panel.locator("[data-database-done]").click();
      assert.equal(
        await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("panda-database-operation:"))),
        false,
      );
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        nonAdministratorHidden: true,
        initialFlagHonored: true,
        rejectedPlanPreservedInput: true,
        cancelGated: true,
        storageFailureBlockedSubmission: true,
        cancels,
        errors,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/boundary-results.json", JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  await app.dispose();
}
