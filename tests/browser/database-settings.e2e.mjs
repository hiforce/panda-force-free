import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const out = ".artifacts/mysql-integration/database-ui";
await mkdir(out, { recursive: true });
const app = await createAppFixture(),
  results = [];
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [chromium, 1440, "zh-HK", "silk"],
    [webkit, 390, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    let initial = true,
      ready = false,
      operation = null,
      operationToken = "",
      migrations = 0,
      retries = 0,
      statusReads = 0,
      allowRecovery = false,
      testCalls = 0,
      selectionCalls = 0,
      holdTest,
      releaseTest,
      holdRetry,
      releaseRetry;
    const current = { driver: "sqlite" },
      target = { driver: "mysql", hostname: "db.example.internal", port: 3306, database: "panda_app" };
    const overview = () => ({
      schema: 1,
      administrator: true,
      initialChoiceRequired: initial,
      current: operation?.status === "complete" ? target : current,
      bot: {
        current: { driver: "mysql", hostname: "bot.example.internal", database: "bots" },
        preservedOnMigration: true,
      },
      readiness: {
        ready,
        modules: [
          { module: "documents", schema: ready, readWrite: ready, importer: ready },
          { module: "bots", schema: true, readWrite: true, importer: true },
        ],
        issues: ready ? [] : [{ code: "incompleteDatabaseBackend", module: "documents" }],
      },
      ...(operation ? { operation } : {}),
    });
    try {
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window === top && /^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      await page.route("**/api/system/database**", async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname.slice("/api/system/database".length),
          body = request.method() === "POST" ? request.postDataJSON() : null;
        const json = (value, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (path === "") return json(overview());
        if (path === "/selection") {
          assert.deepEqual(body, { driver: "sqlite" });
          selectionCalls++;
          initial = false;
          return json(overview());
        }
        if (path === "/test") {
          testCalls++;
          assert.equal(body.password, "synthetic-private-password");
          assert.equal(body.hostname, target.hostname);
          if (holdTest) await holdTest;
          return json(
            testCalls === 1
              ? { ok: false, issues: [{ code: "connectionFailed" }] }
              : { ok: true, serverVersion: "8.4-fixture", strictMode: true, issues: [] },
          );
        }
        if (path === "/plan") {
          assert.equal(body.password, "synthetic-private-password");
          return json({
            id: "opaque-fixture-plan",
            source: current,
            target,
            restartRequired: true,
            ready,
            modules: [
              { module: "documents", action: "copy", tableCount: 18, rows: 123 },
              { module: "creation", action: "copy", tableCount: 3, rows: 4 },
              { module: "bots", action: "preserve", tableCount: 7, rows: 9 },
            ],
            issues: [],
            expiresAt: Date.now() + 60000,
          });
        }
        if (path === "/migrate") {
          migrations++;
          assert.equal(migrations, 1);
          assert.deepEqual(Object.keys(body).sort(), ["planId", "requestId", "statusToken"]);
          assert.equal(body.planId, "opaque-fixture-plan");
          assert.match(body.statusToken, /^[a-zA-Z0-9_-]{43}$/);
          operationToken = body.statusToken;
          const saved = await page.evaluate(() =>
            JSON.parse(
              sessionStorage.getItem(
                Object.keys(sessionStorage).find((k) => k.startsWith("panda-database-operation:")),
              ),
            ),
          );
          assert.deepEqual(saved, { id: body.requestId, statusToken: body.statusToken });
          operation = {
            id: body.requestId,
            status: "running",
            stage: "copy",
            source: current,
            target,
            modules: [
              { module: "documents", stage: "copy", rows: 42, totalRows: 123 },
              { module: "bots", stage: "preserved", rows: 9 },
            ],
            startedAt: Date.now(),
            updatedAt: Date.now(),
            canRetry: false,
            canCancel: true,
          };
          return route.abort("failed");
        }
        if (path === `/operations/${operation?.id}`) {
          assert.equal(request.headers()["x-panda-database-operation"], operationToken);
          assert.equal(new URL(request.url()).search, "");
          statusReads++;
          if (!allowRecovery) return json({ error: { code: "operationNotFound" } }, 404);
          return json(operation);
        }
        if (path === `/operations/${operation?.id}/retry`) {
          assert.equal(request.headers()["x-panda-database-operation"], operationToken);
          retries++;
          if (holdRetry) await holdRetry;
          operation = {
            ...operation,
            status: "running",
            stage: "verify",
            canRetry: false,
            canCancel: false,
            error: undefined,
          };
          return route.abort("failed");
        }
        throw Error("Unexpected database request " + path);
      });
      await page.goto(app.base + "/workspace");
      const setup = page.locator("[data-database-setup][open]");
      await setup.waitFor();
      assert.equal(await setup.locator("[data-database-sqlite]").evaluate((e) => e === document.activeElement), true);
      await page.screenshot({ path: `${out}/setup-${locale}-${width}.png` });
      if (locale === "en") {
        await setup.locator("[data-database-sqlite]").press("Enter");
        await setup.waitFor({ state: "detached" });
        assert.equal(selectionCalls, 1);
        await page.goto(app.base + "/settings/storage");
      } else await setup.locator("[data-database-configure]").click();
      const panel = page.locator("[data-database-settings]"),
        field = (name) => panel.locator(`[data-database-field="${name}"]`);
      await field("hostname").waitFor();
      assert.equal(await panel.evaluate((e) => getComputedStyle(e).display), "grid");
      assert.equal(await panel.locator("[data-database-review]").isDisabled(), true);
      assert.equal(await panel.locator("[data-database-test]").isEnabled(), true);
      assert.match(await panel.innerText(), /Bot/);
      await field("hostname").fill(target.hostname);
      await field("database").fill(target.database);
      await field("username").fill("panda_user");
      await field("password").fill("synthetic-private-password");
      const advanced = panel.locator("[data-database-advanced]");
      await advanced.locator("summary").focus();
      await advanced.locator("summary").press("Space");
      await field("max").fill("4");
      holdTest = new Promise((resolve) => {
        releaseTest = resolve;
      });
      await panel.locator("[data-database-test]").click();
      await waitFor(() => testCalls === 1);
      assert.equal(await field("hostname").isDisabled(), true);
      assert.equal(await field("password").inputValue(), "synthetic-private-password");
      releaseTest();
      holdTest = null;
      await waitFor(async () => !(await field("hostname").isDisabled()));
      assert.equal(await field("username").inputValue(), "panda_user");
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/unavailable-${locale}-${width}.png` });
      ready = true;
      await panel.locator("[data-database-refresh]").click();
      await waitFor(async () => !(await panel.locator("[data-database-review]").isDisabled()));
      assert.equal(await field("hostname").inputValue(), target.hostname);
      assert.equal(await advanced.evaluate((e) => e.open), true);
      const alternate = locale === "en" ? "zh-HK" : locale === "zh-CN" ? "zh-TW" : locale === "zh-HK" ? "en" : "zh-CN";
      await field("hostname").focus();
      await field("hostname").evaluate((e) => e.setSelectionRange(3, 3));
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), alternate);
      assert.equal(await field("hostname").inputValue(), target.hostname);
      assert.equal(await field("hostname").evaluate((e) => e === document.activeElement), true);
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await panel.locator("[data-database-test]").click();
      await waitFor(() => testCalls === 2);
      await waitFor(async () => !(await field("hostname").isDisabled()));
      await panel.locator("[data-database-review]").click();
      await panel.locator("[data-database-migrate]").waitFor();
      assert.equal(await panel.locator("#database-plan-title").evaluate((e) => e === document.activeElement), true);
      await page.screenshot({ path: `${out}/plan-${locale}-${width}.png` });
      await panel.locator("[data-database-edit]").click();
      assert.equal(await field("password").inputValue(), "synthetic-private-password");
      assert.equal(await field("database").inputValue(), target.database);
      await panel.locator("[data-database-review]").click();
      await panel.locator("[data-database-migrate]").click();
      await waitFor(() => migrations === 1);
      await waitFor(() => statusReads > 0);
      assert.equal(await panel.locator("[data-database-configuration]").isVisible(), false);
      await page.screenshot({ path: `${out}/unknown-${locale}-${width}.png` });
      const stored = await page.evaluate(() => ({
        local: Object.values(localStorage).join("|"),
        session: Object.values(sessionStorage).join("|"),
      }));
      for (const secret of ["synthetic-private-password", "db.example.internal", "panda_app", "panda_user"]) {
        assert.equal(stored.local.includes(secret), false);
        assert.equal(stored.session.includes(secret), false);
      }
      allowRecovery = true;
      await page.reload();
      await panel.locator("[data-database-result]").waitFor();
      await waitFor(() => statusReads > 1);
      assert.equal(migrations, 1);
      assert.equal(await panel.locator("[data-database-cancel]").count(), 1);
      await page.screenshot({ path: `${out}/copy-${locale}-${width}.png` });
      operation = {
        ...operation,
        status: "waiting-restart",
        stage: "restart",
        canCancel: false,
        modules: [
          { module: "documents", stage: "complete", rows: 123, totalRows: 123 },
          { module: "bots", stage: "preserved", rows: 9 },
        ],
      };
      await panel.locator("[data-database-recover]").click();
      await waitFor(
        async () =>
          await panel
            .locator("[data-database-result]")
            .innerText()
            .then((s) => /restart|重启|重新啟動/.test(s)),
      );
      assert.equal(await panel.locator("[data-database-cancel]").count(), 0);
      await page.screenshot({ path: `${out}/restart-${locale}-${width}.png` });
      operation = {
        ...operation,
        status: "failed",
        stage: "failed",
        canRetry: true,
        canCancel: true,
        error: { code: "migrationVerificationFailed", module: "documents" },
      };
      await panel.locator("[data-database-recover]").click();
      await panel.locator("[data-database-retry]").waitFor();
      holdRetry = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      await panel.locator("[data-database-retry]").click();
      await waitFor(() => retries === 1);
      assert.equal(await panel.locator("[data-database-retry]").isDisabled(), true);
      releaseRetry();
      holdRetry = null;
      await waitFor(async () => (await panel.locator("[data-database-retry]").count()) === 0);
      assert.equal(retries, 1);
      operation = { ...operation, status: "complete", stage: "complete", canRetry: false, canCancel: false };
      await panel.locator("[data-database-recover]").click();
      await panel.locator("[data-database-done]").waitFor();
      await page.screenshot({ path: `${out}/complete-${locale}-${width}.png` });
      await panel.locator("[data-database-done]").click();
      assert.equal(
        await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("panda-database-operation:"))),
        false,
      );
      if (width === 390) {
        await page.setViewportSize({ width: 767, height: 1000 });
        const heights = await panel
          .locator("[data-database-field]:visible")
          .evaluateAll((items) => items.map((el) => el.getBoundingClientRect().height));
        assert.equal(
          heights.every((height) => height >= 44),
          true,
        );
        await page.screenshot({ path: `${out}/touch-${locale}-767.png` });
        await page.setViewportSize({ width: 320, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/compact-${locale}-320.png` });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const overflow = await panel.evaluate((el) => el.scrollWidth > el.clientWidth);
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      results.push({
        locale,
        width,
        engine: engine === webkit ? "webkit" : "chromium",
        migrations,
        retries,
        statusReads,
        selectionCalls,
        errors,
        overflow,
      });
    } catch (error) {
      console.error("Database browser case failed", locale, width, error);
      const pages = context.pages();
      if (pages[0]) await pages[0].screenshot({ path: `${out}/failure-${locale}-${width}.png` }).catch(() => {});
      throw error;
    } finally {
      releaseTest?.();
      releaseRetry?.();
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/browser-results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await app.dispose();
}
