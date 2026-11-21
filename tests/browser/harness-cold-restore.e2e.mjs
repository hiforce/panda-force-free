import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_COLD_RESTORE_PROOF || ".artifacts/harness-cold-restore";
await mkdir(out, { recursive: true });
const records = [];
for (const [width, locale] of [
  [1440, "en"],
  [390, "zh-CN"],
])
  for (const runtimeId of ["codex", "grok-cold"]) {
    const app = await createAppFixture({
      completedTurnNotifications: true,
      startupTimeoutMs: 60000,
      extraEnvironment: ({ dir }) => {
        const account = join(dir, "cold-account");
        mkdirSync(account, { recursive: true });
        writeFileSync(join(account, "auth.json"), '{"fixture":{"access_token":"fixture-only"}}');
        return {
          PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
            {
              id: "grok-cold",
              name: "Grok Build",
              command: new URL("../support/grok-acp-fixture.mjs", import.meta.url).pathname,
              accountHome: account,
            },
          ]),
        };
      },
    });
    const browser = await (width === 1440 ? chromium : webkit).launch(),
      context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 900 : 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
    try {
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const before = await (await context.request.get(app.base + "/api/harness-runtimes")).json();
      assert.equal(before.runtimes.find((r) => r.id === runtimeId).capabilities, null);
      const created = await context.request.post(app.base + "/api/personal/harness/conversations", {
        headers: { Origin: app.base },
        data: { runtimeId },
      });
      assert.equal(created.status(), 201);
      const id = (await created.json()).conversation.id,
        page = await context.newPage(),
        errors = [],
        probes = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().endsWith("/" + runtimeId + "/probe")) probes.push(request.url());
      });
      await page.goto(app.base + "/task/" + encodeURIComponent("harness:" + id));
      await page.locator("#composerSettingsButton").click();
      const row = page.locator('[data-composer-setting="permissions"]');
      await page.waitForFunction(() => {
        const n = document.querySelector('[data-composer-setting="permissions"]');
        return n && !n.disabled;
      });
      assert.equal(probes.length, 1);
      const after = await (await context.request.get(app.base + "/api/harness-runtimes")).json(),
        runtime = after.runtimes.find((r) => r.id === runtimeId);
      assert.equal(runtime.status, "ready");
      assert(runtime.capabilities.permissionModes.includes("ask"));
      await row.click();
      assert(await page.locator('input[name="session-permission"][value="ask"]').isChecked());
      assert.equal(await page.locator('#sessionSettingsForm button[type="submit"]').isDisabled(), false);
      await page.screenshot({ path: `${out}/${runtimeId}-${locale}-${width}.png`, scale: "css" });
      await page.locator("[data-settings-dismiss]").first().click();
      await page.locator("#prompt").fill("Cold restoration fixture message");
      await page.locator("#sendButton").click();
      await waitFor(async () => {
        const value = await (await context.request.get(app.base + "/api/personal/harness/conversations/" + id)).json();
        return value.run?.status === "complete";
      });
      const final = await (await context.request.get(app.base + "/api/personal/harness/conversations/" + id)).json();
      assert.equal(final.run.model, runtimeId === "codex" ? "gpt-fixture" : "grok-fixture");
      assert.equal(final.conversation.permissionMode, "ask");
      assert.deepEqual(errors, []);
      records.push({
        runtimeId,
        width,
        locale,
        initialDiscoveryEmpty: true,
        probeCount: probes.length,
        permissionsRestored: true,
        correctProviderModel: final.run.model,
        errors,
      });
    } finally {
      await context.close();
      await browser.close();
      await app.dispose();
    }
  }
await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
console.log(
  "Cold Codex/Grok Harness restoration discovers permissions independently of native Codex model requests on PC/H5.",
);
