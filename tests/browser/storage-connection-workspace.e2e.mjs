import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_STORAGE_WORKSPACE_PROOF;
if (proof) await mkdir(proof, { recursive: true });
const fixture = await createAppFixture({ startupTimeoutMs: 60000 });
const path = "/api/system/storage-connections";
const credentials = { accessKeyId: "fixtureAccessKey", secretAccessKey: "fixtureSecretKey" };
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1180, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const mobile = width < 768;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: mobile,
        hasTouch: mobile,
        locale,
      });
      await fixture.signIn(context);
      if (locale === "en") {
        const preset = await context.request.post(fixture.base + "/api/system/storage", {
          headers: { Origin: fixture.base },
          data: {
            action: "configure",
            mode: "s3",
            kinds: ["image"],
            revision: 0,
            operationId: crypto.randomUUID(),
            profile: {
              label: "Active originals fixture",
              bucket: "fixture-originals",
              endpoint: "https://s3.eu-west-1.amazonaws.com",
              region: "eu-west-1",
              prefix: "originals",
              forcePathStyle: false,
              credentials,
            },
          },
        });
        assert.equal(preset.status(), 200);
      }
      await context.addInitScript((locale) => {
        if (window === window.top) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const page = await context.newPage();
      const problems = [];
      page.on("pageerror", (error) => problems.push(error.message));
      const click = (node) => (mobile ? node.tap() : node.click());
      const photo = (name) =>
        proof && page.screenshot({ animations: "disabled", path: join(proof, name + "-" + locale + ".png") });
      await page.goto(fixture.base + "/tools/remote");
      await page.locator("[data-remote-add]").waitFor();
      const prep = page.locator("#workspacePreparationContinue");
      try {
        if (await prep.isVisible()) await prep.click({ timeout: 2000 });
      } catch (error) {
        if (await prep.isVisible()) throw error;
      }
      if (mobile) await click(page.locator("#workspaceNavigationToggle"));
      const storageLink = page.locator('.workspace-tool-navigation [data-workspace-tool="storage"]');
      const remoteLink = page.locator('.workspace-tool-navigation [data-workspace-tool="remote"]');
      assert(
        await storageLink.evaluate(
          (node, id) => node.previousElementSibling?.getAttribute("data-workspace-tool") === id,
          await remoteLink.getAttribute("data-workspace-tool"),
        ),
      );
      await click(storageLink);
      await page.waitForURL("**/tools/storage");
      const add = page.locator("[data-storage-tools-add]");
      const addBox = await add.boundingBox();
      if (mobile) assert(addBox.height >= 44 && addBox.height <= 56);
      const modal = page.locator(".storage-connection-editor");
      const submit = modal.locator("button[type=submit]");
      const list = page.locator("[data-storage-tools-list]");
      const result = page.locator("[data-storage-tools-result]");
      const legacy = list.locator("li").filter({ hasText: "Active originals fixture" });
      await legacy.locator('a[href="/settings/storage"]').waitFor();
      const prior = await (await context.request.get(fixture.base + "/api/system/storage")).json();
      await click(add);
      const field = (name) => modal.locator(`[name="storage-${name}"]`);
      const provider = field("provider");
      assert.deepEqual(await provider.locator("option").evaluateAll((options) => options.map((node) => node.value)), [
        "s3",
        "oss",
        "google-drive",
      ]);
      const name = locale + (mobile ? " OSS archive" : " S3 archive");
      await provider.selectOption(mobile ? "oss" : "s3");
      await field("name").fill(name);
      await field("bucket").fill(mobile ? "panda-image-archive" : "panda-creative-archive");
      await field("region").fill(mobile ? "cn-hangzhou" : "eu-west-1");
      await field("accessKeyId").fill(credentials.accessKeyId);
      await field("secretAccessKey").fill(credentials.secretAccessKey);
      let writes = 0;
      await page.route(`**${path}`, (route) => {
        if (route.request().method() !== "POST" || ++writes !== 1) return route.continue();
        return route.fulfill({ status: 503, json: { error: { messageId: "storageConnections.unavailable" } } });
      });
      await click(submit);
      await modal.getByRole("alert").waitFor();
      assert.equal(await field("bucket").inputValue(), mobile ? "panda-image-archive" : "panda-creative-archive");
      await field("accessKeyId").fill("syntheticAccess42");
      await field("secretAccessKey").fill("syntheticSecret42");
      await photo("provider-form");
      await click(submit);
      await modal.waitFor({ state: "hidden" });
      await list.getByText(name, { exact: true }).waitFor();
      assert.equal(writes, 2);
      assert.deepEqual(await (await context.request.get(fixture.base + "/api/system/storage")).json(), prior);
      await page.reload();
      await list.getByText(name, { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await photo("registered-connections");

      await click(add);
      await provider.selectOption("google-drive");
      await field("name").fill("Google fixture");
      await field("clientId").fill("fixture.apps.googleusercontent.com");
      await field("clientSecret").fill("fixture-google-secret-only");
      await photo("google-drive-authorization");
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<title>Synthetic Google consent</title>" }),
      );
      await click(submit);
      await page.waitForURL("https://accounts.google.com/**");
      const consent = new URL(page.url());
      const state = consent.searchParams.get("state");
      assert(state);
      assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
      const callback = new URL(consent.searchParams.get("redirect_uri"));
      callback.search = new URLSearchParams({ state, error: "access_denied" }).toString();
      await page.goto(callback.href);
      await result.waitFor();
      assert(!(await list.textContent()).includes("Google fixture"));
      assert.deepEqual(await (await context.request.get(fixture.base + "/api/system/storage")).json(), prior);
      const rows = await context.request.get(fixture.base + path);
      assert(!(await rows.text()).includes("syntheticSecret42"));
      const forged = await context.request.post(fixture.base + path, {
        data: {},
        headers: { Origin: "https://cross-site.invalid" },
      });
      assert([401, 403].includes(forged.status()));
      const unauthorized = await browser.newContext();
      assert.equal((await unauthorized.request.get(fixture.base + path)).status(), 401);
      const landing = await unauthorized.request.get(fixture.base + path + "/google/callback");
      assert.equal(landing.status(), 200);
      assert.match(landing.headers()["content-security-policy"], /connect-src 'self'/);
      assert.equal(
        (
          await unauthorized.request.post(fixture.base + path + "/google/complete", {
            headers: { Origin: fixture.base },
            data: { state: "", code: "", denied: false },
          })
        ).status(),
        401,
      );
      await unauthorized.close();
      assert.deepEqual(problems, []);
      console.log(
        `${locale} ${width}: storage navigation, independent provider registration, retry and Drive cancellation verified`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
