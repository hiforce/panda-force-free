import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = process.env.PANDA_HARNESS_SWITCH_PROOF || ".artifacts/harness-switch-latency";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "grok-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(
      join(account, "auth.json"),
      JSON.stringify({ fixture: { access_token: "fixture-only", sessionDelayMs: 1200 } }),
    );
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome: account,
        },
      ]),
    };
  },
});
const records = [];
try {
  for (const locale of (process.env.PANDA_HARNESS_SWITCH_LOCALES || "en,zh-CN,zh-HK,zh-TW").split(","))
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 768,
          hasTouch: width < 768,
          ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
        });
      let page;
      const suffix = locale.toLowerCase() + "-" + width;
      let id = "";
      try {
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        await app.signIn(context);
        const api = async (path, body, method = "POST") => {
          const response = await context.request.fetch(app.base + path, {
            method,
            headers: { Origin: app.base },
            data: body,
          });
          assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
          return response.json();
        };
        const created = await api("/api/harness-runtimes", {
          name: "Grok " + suffix,
          profileId: "grok-local",
          enabled: true,
          access: "administrators",
          defaultModel: null,
          defaultEffort: null,
        });
        id = created.runtimes.find((runtime) => runtime.name === "Grok " + suffix).id;
        page = await context.newPage();
        page.setDefaultTimeout(20000);
        const errors = [],
          requests = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname === "/api/model-catalog" && url.searchParams.get("runtimeId") === id)
            requests.push(request.url());
        });
        await page.goto(app.base + "/new");
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
        const draft = "Preserve this draft while switching " + suffix;
        await page.locator("#prompt").fill(draft);
        const trigger = page.locator("#harnessButton"),
          menu = page.locator("#harnessMenu"),
          target = menu.locator(`[data-harness-select="${id}"]`);
        const start = performance.now();
        await trigger.click();
        await target.click();
        assert.equal(await trigger.getAttribute("aria-busy"), "true");
        const switching = await page.evaluate(() =>
          globalThis[Symbol.for("PandaForce.browserI18n")].t("harness.switching"),
        );
        assert.match(await trigger.getAttribute("aria-label"), new RegExp(switching));
        assert.equal(await target.locator('[role="status"]').innerText(), switching);
        await page.screenshot({ path: join(out, "switching-" + suffix + ".png") });
        await menu.waitFor({ state: "hidden" });
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
        const coldMs = Math.round(performance.now() - start);
        assert.equal(requests.length, 1, "Warm-up, selection and model projection must share one discovery");
        assert.equal(await page.locator("#prompt").inputValue(), draft);
        assert.equal(await trigger.getAttribute("aria-busy"), "false");
        assert.match(await trigger.getAttribute("aria-label"), /Grok/);
        await trigger.click();
        await menu.locator('[data-harness-select="codex"]').click();
        await menu.waitFor({ state: "hidden" });
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
        const warmStart = performance.now();
        await trigger.click();
        await target.click();
        await menu.waitFor({ state: "hidden" });
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
        const warmMs = Math.round(performance.now() - warmStart);
        assert(warmMs < 1500, "Cached switching must not await the 1200ms ACP session handshake: " + warmMs);
        assert.equal(requests.length, 1);
        assert.equal(await page.locator("#prompt").inputValue(), draft);
        if (locale === "en") {
          await trigger.click();
          await menu.locator('[data-harness-select="codex"]').click();
          await menu.waitFor({ state: "hidden" });
          const catalog = await api("/api/model-catalog", undefined, "GET"),
            current = catalog.runtimes.find((runtime) => runtime.id === id);
          await api("/api/harness-runtimes/" + id, { ...current, name: "Grok retry " + suffix }, "PATCH");
          let rejectFirst;
          await page.route("**/api/model-catalog?runtimeId=" + id, async (route) => {
            if (!rejectFirst) {
              await new Promise((resolve) => {
                rejectFirst = resolve;
              });
              await route.abort("failed");
            } else await route.continue();
          });
          const updated = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/harness-runtimes",
          );
          await page.evaluate(() => dispatchEvent(new Event("panda-force:harness-runtimes-updated")));
          await updated;
          await trigger.click();
          await target.click();
          await page.waitForFunction(
            () => document.querySelector("#harnessButton").getAttribute("aria-busy") === "true",
          );
          assert(rejectFirst);
          rejectFirst();
          await page.locator("#persistentErrors .persistent-error").first().waitFor();
          await page.waitForFunction(
            () => document.querySelector("#harnessButton").getAttribute("aria-busy") === "false",
          );
          assert.match(await trigger.getAttribute("aria-label"), /Codex/);
          assert.equal(await page.locator("#prompt").inputValue(), draft);
          await target.click();
          await menu.waitFor({ state: "hidden" });
          await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
          assert.match(await trigger.getAttribute("aria-label"), /Grok/);
          const native = await api("/api/rpc", {
            id: crypto.randomUUID(),
            method: "thread/start",
            params: { cwd: app.alpha },
          });
          await page.goto(app.base + "/task/" + native.result.thread.id);
          await page.waitForFunction(
            (id) => globalThis.__pandaForceDebug?.state.active?.id === id,
            native.result.thread.id,
          );
          await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
          await page.locator("#prompt").fill(draft);
          await trigger.click();
          await target.click();
          await menu.waitFor({ state: "hidden" });
          await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id.startsWith("harness:"));
          const importedId = await page.evaluate(() => globalThis.__pandaForceDebug?.state.active.id);
          assert.equal(await page.locator("#prompt").inputValue(), draft);
          await trigger.click();
          await menu.locator('[data-harness-select="codex"]').click();
          await menu.waitFor({ state: "hidden" });
          assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug?.state.active.id), importedId);
          await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
          assert.match(await trigger.getAttribute("aria-label"), /Codex/);
          assert.equal(await page.locator("#prompt").inputValue(), draft);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(out, "ready-" + suffix + ".png") });
        records.push({
          locale,
          width,
          coldMs,
          warmMs,
          coldDiscoveryRequests: 1,
          repeatedDiscoveryRequests: 0,
          immediateProgress: true,
          draftPreserved: true,
          failureRecovery: locale === "en",
        });
      } catch (error) {
        if (page) {
          await page.screenshot({ path: join(out, "failure-" + suffix + ".png") });
          await writeFile(
            join(out, "failure-" + suffix + ".txt"),
            String(error) + "\n" + (await page.locator("body").innerText()),
          );
        }
        throw error;
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(join(out, "result.json"), JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, records }));
} finally {
  await app.dispose();
}
