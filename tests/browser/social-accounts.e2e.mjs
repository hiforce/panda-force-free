import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture();
await mkdir(".artifacts/social-accounts-browser", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
      await app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get"),
        code = "social-" + width;
      const project = (
        await api("/api/projects", { code, name: "Social publication", revision: catalog.revision })
      ).projects.find((item) => item.code === code);
      await api("/api/document-spaces", {
        projectId: project.id,
        code: "docs",
        name: "Product articles",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      const open = async () => {
        await page.goto(app.base + "/documents?project=" + project.id);
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await openConnectedDocumentSources(page);
        await page.locator('[data-doc-action="delivery"]').click();
        await page.locator('[data-delivery-action="accounts"]').click();
        await page.locator("#socialAccountEditor").waitFor();
      };
      await open();
      assert.equal(
        await page.locator("#account-callback").inputValue(),
        app.base + "/api/publication-accounts/x/callback",
      );
      await page.locator("#account-name").fill("Author account");
      await page.locator("#account-clientId").fill("fixture-client");
      await page.locator("#account-clientSecret").fill("fixture-browser-secret");
      if (width === 1440)
        await page.route(
          "**/api/publication-accounts",
          async (route) => {
            await route.fetch();
            await route.abort("failed");
          },
          { times: 1 },
        );
      await page.locator('#socialAccountEditor [type="submit"]').click();
      if (width === 1440) {
        await page.waitForFunction(() =>
          document.querySelector("#socialAccountNotice").textContent.includes("temporarily unavailable"),
        );
        await page.locator('[data-account-action="refresh"]').click();
      }
      await page.locator('[data-account-action="authorize"]').waitFor();
      const saved = (await api("/api/publication-accounts?project=" + project.id, undefined, "get")).accounts[0];
      assert.equal(saved.application.confidential, true);
      assert.equal(JSON.stringify(saved).includes("fixture-browser-secret"), false);
      assert.equal(await page.locator('#socialAccountForm input[type="password"]').count(), 0);
      assert.equal(
        await page.evaluate(() =>
          JSON.stringify({ ...localStorage, ...sessionStorage }).includes("fixture-browser-secret"),
        ),
        false,
      );
      await page.locator('[data-account-action="configure"]').click();
      await page.locator("#account-clientSecret").fill("unsaved-fixture-secret");
      await page.locator('[data-account-action="refresh"]').click();
      await page.locator("#account-clientSecret").waitFor({ state: "detached" });
      const stale = saved.version;
      await api(
        "/api/publication-accounts/detail?id=" + saved.id,
        { version: stale, name: "Changed elsewhere", enabled: true },
        "put",
      );
      await page.locator("#account-name").fill("Stale change");
      await page.locator('#socialAccountEditor [type="submit"]').click();
      await page
        .waitForFunction(() => {
          const text = document.querySelector("#socialAccountNotice").textContent;
          return (
            text.includes("connection changed") ||
            text.includes("连接已变更") ||
            text.includes("连接已更新") ||
            text.includes("连接已更改")
          );
        })
        .catch(async (error) => {
          throw new Error(`${error.message}: ${await page.locator("#socialAccountNotice").textContent()}`);
        });
      await page.locator('[data-account-action="refresh"]').click();
      await page.waitForFunction(() => document.querySelector("#account-name").value === "Changed elsewhere");
      assert.equal(
        await page.locator("#deliveryAccounts").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
      );
      assert.equal((await page.locator("#deliveryAccounts").innerText()).includes("accounts."), false);
      await page.screenshot({ path: `.artifacts/social-accounts-browser/${width}-${locale}.png` });
      let authorization;
      await page.route("https://x.com/**", async (route) => {
        authorization = new URL(route.request().url());
        await route.fulfill({ contentType: "text/html", body: "<html><body>Fixture authorization</body></html>" });
      });
      await page.locator('[data-account-action="authorize"]').click();
      await page.waitForURL("https://x.com/**");
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.has("client_secret"), false);
      await page.goto(
        app.base +
          "/api/publication-accounts/x/callback?" +
          new URLSearchParams({ state: authorization.searchParams.get("state"), error: "access_denied" }),
      );
      await page.waitForURL((url) => url.pathname === "/api/publication-accounts/authorization-result");
      assert.equal(new URL(page.url()).searchParams.has("state"), false);
      assert.match(
        await page.locator("main").innerText(),
        locale === "en" ? /Authorization did not finish/ : /授权未完成/,
      );
      await page.screenshot({ path: `.artifacts/social-accounts-browser/${width}-${locale}-result.png` });
      await page.locator("main a").click();
      await page.waitForURL(app.base + "/documents?project=" + project.id);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log("Social account configuration and OAuth handoff passed on desktop Chromium and mobile WebKit.");
} finally {
  await app.dispose();
}
