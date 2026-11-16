import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const out = ".artifacts/mysql-integration/database-ui";
await mkdir(out, { recursive: true });
const id = "d9e301d5-153e-40f2-8a44-fc875d2ffbc7",
  token = "T".repeat(43),
  records = [];
let operation,
  normalReady = false,
  normalResponse = 200,
  reads = 0,
  retries = 0,
  rejectPrivate = false,
  publicStatus = "running";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/api/system/database/maintenance") return Response.json({ operationId: id, status: publicStatus });
    if (path === "/api/system/database")
      return normalReady
        ? normalResponse !== 200
          ? Response.json({ error: { code: "administratorRequired" } }, { status: normalResponse })
          : Response.json({
              schema: 1,
              administrator: true,
              current: { driver: "mysql" },
              initialChoiceRequired: false,
              readiness: { ready: true, modules: [], issues: [] },
            })
        : Response.json({ error: { code: "databaseUnavailable" } }, { status: 503 });
    if (path === `/api/system/database/operations/${id}`) {
      assert.equal(request.headers.get("X-Panda-Database-Operation"), token);
      reads++;
      if (rejectPrivate) return Response.json({ error: { code: "operationTokenInvalid" } }, { status: 401 });
      return Response.json(operation);
    }
    if (path === `/api/system/database/operations/${id}/retry`) {
      assert.equal(request.headers.get("X-Panda-Database-Operation"), token);
      retries++;
      operation = { ...operation, status: "running", stage: "verify", canRetry: false, error: undefined };
      return Response.json(operation);
    }
    if (path === "/settings/storage")
      return new Response("<!doctype html><p data-normal-ready>Normal application ready</p>", {
        headers: { "content-type": "text/html" },
      });
    if (path === "/") {
      return new Response(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/workbench-forms.css"><link rel="stylesheet" href="/workbench-layout.css"><link rel="stylesheet" href="/appearance.css"><link rel="stylesheet" href="/database.css"><script type="module" src="/database-maintenance.bundle.js"></script></head><body><div id="database-maintenance"></div></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (
      /^\/(?:style|workbench|workbench-forms|workbench-layout|appearance|database)\.css$/.test(path) ||
      ["/database-maintenance.bundle.js", "/i18n.js", "/http-client.js"].includes(path) ||
      /^\/locales\/(en|zh-CN|zh-HK|zh-TW)\.json$/.test(path)
    ) {
      const file = Bun.file("public" + path);
      if (await file.exists()) return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1440, "zh-HK"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch(),
      source = { driver: "sqlite" },
      target = { driver: "mysql", hostname: "private-target.internal", database: "private_database" };
    try {
      publicStatus = "running";
      normalReady = false;
      normalResponse = locale === "en" ? 401 : locale === "zh-CN" ? 403 : 200;
      reads = 0;
      retries = 0;
      rejectPrivate = false;
      operation = {
        id,
        status: "running",
        stage: "copy",
        source,
        target,
        modules: [{ module: "documents", stage: "copy", rows: 17, totalRows: 42 }],
        startedAt: Date.now(),
        updatedAt: Date.now(),
        canRetry: false,
        canCancel: false,
      };
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await context.addInitScript((locale) => {
        if (window === top && /^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      await page.goto(server.url.href);
      await page.locator(".database-maintenance-shell").waitFor();
      await page.locator("[data-database-recover]").click();
      assert.equal(reads, 0);
      assert.equal(await page.locator("[data-database-result]").count(), 0);
      assert.equal((await page.locator("body").innerText()).includes("private-target.internal"), false);
      await page.screenshot({ path: `${out}/maintenance-public-${locale}-${width}.png` });
      publicStatus = "complete";
      normalReady = true;
      await page.locator("[data-database-recover]").click();
      await page.locator("[data-normal-ready]").waitFor();
      assert.equal(reads, 0);
      publicStatus = "running";
      normalReady = false;
      await page.goto(server.url.href);
      await page.locator("[data-database-recover]").waitFor();

      await page.evaluate(
        ({ id, token }) => {
          sessionStorage.setItem("panda-database-operation:old-corrupt", "invalid json");
          sessionStorage.setItem("panda-database-operation:fixture-owner", JSON.stringify({ id, statusToken: token }));
        },
        { id, token },
      );
      await page.reload();
      await page.locator("[data-database-result]").waitFor();
      assert.equal(await page.locator("[data-database-cancel]").count(), 0);
      assert.equal(await page.locator("progress").count(), 0);
      await page.screenshot({ path: `${out}/maintenance-copy-${locale}-${width}.png` });
      operation = {
        ...operation,
        status: "failed",
        stage: "failed",
        canRetry: true,
        error: { code: "migrationVerificationFailed", module: "documents" },
      };
      publicStatus = "failed";
      await page.locator("[data-database-recover]").click();
      await page.locator("[data-database-retry]").waitFor();
      await page.screenshot({ path: `${out}/maintenance-failed-${locale}-${width}.png` });
      await page.locator("[data-database-retry]").click();
      await page.waitForFunction(() => !document.querySelector("[data-database-retry]"));
      assert.equal(retries, 1);
      operation = { ...operation, status: "complete", stage: "complete" };
      publicStatus = "complete";
      rejectPrivate = locale === "en" || locale === "zh-TW";
      await page.locator("[data-database-recover]").click();
      await page.waitForTimeout(100);
      assert.equal(new URL(page.url()).pathname, "/");
      await page.screenshot({ path: `${out}/maintenance-restart-${locale}-${width}.png` });
      normalReady = true;
      await page.locator("[data-database-recover]").click();
      await page.locator("[data-normal-ready]").waitFor();
      assert.equal(new URL(page.url()).pathname, "/settings/storage");
      assert.deepEqual(
        await page.evaluate(() => JSON.parse(sessionStorage.getItem("panda-database-operation:fixture-owner"))),
        { id, statusToken: token },
      );
      assert.equal(
        requests.some(
          (path) =>
            path === "/auth-bootstrap.js" ||
            path === "/app.bundle.js" ||
            path.startsWith("/api/auth") ||
            path.startsWith("/api/rpc"),
        ),
        false,
      );
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        unauthorizedReads: 0,
        privateReads: reads,
        retries,
        normalReadinessWaited: true,
        normalHandoffStatus: normalResponse,
        recoveryPreserved: true,
        terminalPrivateTokenRejected: rejectPrivate,
        authBootstrap: false,
        errors,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/maintenance-results.json", JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  server.stop(true);
}
