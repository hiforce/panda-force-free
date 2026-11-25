import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_SETTINGS_PROOF || ".artifacts/harness-permission-settings";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "permission-settings-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), '{"fixture":{"access_token":"fixture-only"}}');
    const zcodeSettings = join(dir, "zcode-provider.json");
    writeFileSync(zcodeSettings, "{}");
    const claude = join(dir, "claude-draft-account");
    const claudeAdapter = new URL("../support/antigravity-acp-fixture.mjs", import.meta.url).pathname;
    mkdirSync(claude, { mode: 0o700, recursive: true });
    writeFileSync(join(claude, "signed-in"), "");
    writeFileSync(join(claude, "native-full"), "");
    return {
      PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "claude-draft",
          name: "Claude Code",
          command: claudeAdapter,
          claudeCommand: claudeAdapter,
          accountHome: claude,
        },
      ]),
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-settings",
          name: "Grok Build",
          command: new URL("../support/grok-acp-fixture.mjs", import.meta.url).pathname,
          accountHome: account,
        },
      ]),
      PANDA_FORCE_ZCODE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "zcode-settings",
          name: "ZCode",
          command: new URL("../support/zcode-stdio-fixture.mjs", import.meta.url).pathname,
          builtinConfig: zcodeSettings,
          providerConfig: zcodeSettings,
          providerId: "fixture",
          model: "ZCode Fixture",
        },
      ]),
    };
  },
});
const records = [];
try {
  for (const width of [1440, 390])
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const browser = await (width === 1440 ? chromium : webkit).launch(),
        context = await browser.newContext({
          viewport: { width, height: width === 1440 ? 900 : 844 },
          isMobile: width < 768,
          hasTouch: width < 768,
        });
      try {
        await app.signIn(context);
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-permission-full-access", "true");
          }
        }, locale);
        const page = await context.newPage(),
          errors = [];
        page.setDefaultTimeout(20000);
        page.on("pageerror", (error) => errors.push(error.message));
        const permissionRow = page.locator('[data-composer-setting="permissions"]');
        const open = async () => {
          await page.locator("#composerSettingsButton").click();
          await permissionRow.waitFor();
          await waitFor(async () => !(await permissionRow.isDisabled()));
          assert.equal(await permissionRow.isDisabled(), false);
          await permissionRow.click();
        };
        const choose = async (mode) => {
          await open();
          await page.locator(`input[name="session-permission"][value="${mode}"]`).check();
          await page.locator('#sessionSettingsForm button[type="submit"]').click();
        };
        const snapshot = async (id) =>
          (await context.request.get(app.base + "/api/personal/harness/conversations/" + id)).json();
        const send = async (text) => {
          await page.locator("#prompt").fill(text);
          await page.locator("#sendButton").click();
        };
        await page.goto(app.base + "/new");
        await page.locator("#composerSettingsButton").click();
        assert.equal(await permissionRow.isDisabled(), false);
        await permissionRow.click();
        await page.locator('#permissionMenu:not([hidden]) [data-permission-mode="default"]').waitFor();
        await page.keyboard.press("Escape");
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="claude-draft"]').click();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Sonnet Fixture"),
        );
        await choose("full-access");
        const confirmation = page.locator("#fullAccessDialog");
        await confirmation.waitFor({ state: "visible" });
        await confirmation.locator('[value="cancel"]').click();
        await open();
        assert(await page.locator('input[name="session-permission"][value="ask"]').isChecked());
        await page.locator("[data-settings-dismiss]").first().click();
        await choose("full-access");
        await confirmation.waitFor({ state: "visible" });
        await page.screenshot({ path: `${out}/claude-full-access-${locale}-${width}.png`, scale: "css" });
        await page.locator("#confirmFullAccess").click();
        await send("claude.mode");
        await page.locator("#conversation").getByText("bypassPermissions", { exact: true }).waitFor();
        await page.goto(app.base + "/new");
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="grok-settings"]').click();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await page.locator("#toast.show").waitFor({ state: "hidden" });
        await choose("always-approve");
        await send("harness.permission");
        await page
          .locator("#conversation")
          .getByText("Fixture native always-approve active.", { exact: true })
          .waitFor();
        const conversations = (
          await (await context.request.get(app.base + "/api/personal/harness/conversations")).json()
        ).conversations;
        const id = conversations.sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
        await waitFor(async () => !(await snapshot(id)).conversation.activeRunId);
        assert.equal((await snapshot(id)).conversation.permissionMode, "always-approve");
        assert.equal(await page.locator(".harness-permission").count(), 0);
        await page.reload();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await open();
        assert(await page.locator('input[name="session-permission"][value="always-approve"]').isChecked());
        await page.screenshot({ path: `${out}/grok-${locale}-${width}.png`, scale: "css" });
        await page.locator("[data-settings-dismiss]").first().click();
        await choose("ask");
        await waitFor(async () => (await snapshot(id)).conversation.permissionMode === "ask");
        await send("harness.permission-long");
        try {
          await page.locator(".harness-permission").waitFor();
        } catch (error) {
          const value = await snapshot(id);
          await writeFile(`${out}/failed-snapshot.json`, JSON.stringify(value, null, 2));
          await page.screenshot({ path: `${out}/failed.png` });
          console.log(
            JSON.stringify({
              phase: "ask-after-reload",
              run: value.run,
              mode: value.conversation.permissionMode,
              permissions: value.permissions.length,
              visible: await page.locator("#conversation").textContent(),
            }),
          );
          throw error;
        }
        const active = await snapshot(id);
        const blocked = await context.request.patch(app.base + "/api/personal/harness/conversations/" + id, {
          headers: { Origin: app.base },
          data: { permissionMode: "always-approve", revision: active.conversation.revision },
        });
        assert.equal(blocked.status(), 409);
        await page.locator('[data-harness-option="yes"]').click();
        await page.locator(".harness-permission").waitFor({ state: "hidden" });
        await waitFor(async () => !(await snapshot(id)).conversation.activeRunId);
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="codex"]').click();
        await waitFor(async () => (await snapshot(id)).conversation.runtimeId === "codex");
        await page.waitForFunction(
          () => !document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await choose("full-access");
        await page.locator("#fullAccessDialog[open]").waitFor();
        assert.equal((await snapshot(id)).conversation.permissionMode, "ask");
        await page.locator("#confirmFullAccess").click();
        await waitFor(async () => (await snapshot(id)).conversation.permissionMode === "full-access");
        await page.reload();
        await open();
        assert(await page.locator('input[name="session-permission"][value="full-access"]').isChecked());
        await page.screenshot({ path: `${out}/codex-${locale}-${width}.png`, scale: "css" });
        await page.locator("[data-settings-dismiss]").first().click();
        const before = app.calls().filter((c) => c.method === "turn/start").length;
        await send("Codex full-access fixture turn");
        await waitFor(() => app.calls().filter((c) => c.method === "turn/start").length > before);
        const native = app
          .calls()
          .filter((c) => c.method === "turn/start")
          .at(-1).params;
        assert.equal(native.approvalPolicy, "never");
        assert.equal(native.sandboxPolicy.type, "dangerFullAccess");
        await waitFor(async () => !(await snapshot(id)).conversation.activeRunId);
        await choose("ask");
        await waitFor(async () => (await snapshot(id)).conversation.permissionMode === "ask");
        await send("Codex restored approval fixture turn");
        await waitFor(() => app.calls().filter((c) => c.method === "turn/start").length > before + 1);
        const restored = app
          .calls()
          .filter((c) => c.method === "turn/start")
          .at(-1).params;
        assert.equal(restored.approvalPolicy, "on-request");
        assert.equal(restored.sandboxPolicy.type, "workspaceWrite");
        await waitFor(async () => !(await snapshot(id)).conversation.activeRunId);
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="zcode-settings"]').click();
        await waitFor(async () => (await snapshot(id)).conversation.runtimeId === "zcode-settings");
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("ZCode Fixture"),
        );
        await choose("full-access");
        await page.locator("#fullAccessDialog[open]").waitFor();
        assert.equal((await snapshot(id)).conversation.permissionMode, "ask");
        await page.locator("#confirmFullAccess").click();
        await waitFor(async () => (await snapshot(id)).conversation.permissionMode === "full-access");
        await send("ZCode native access fixture");
        await page.locator("#conversation").getByText("Fixture ZCode yolo active.", { exact: true }).waitFor();
        await page.reload();
        await open();
        assert(await page.locator('input[name="session-permission"][value="full-access"]').isChecked());
        await page.screenshot({ path: `${out}/zcode-${locale}-${width}.png`, scale: "css" });
        await page.locator("[data-settings-dismiss]").first().click();
        await send("ZCode resumed access fixture");
        await waitFor(async () => {
          const value = await snapshot(id);
          return (
            !value.conversation.activeRunId &&
            value.messages.filter((m) => m.text === "Fixture ZCode yolo active.").length === 2
          );
        });
        await choose("ask");
        await waitFor(async () => (await snapshot(id)).conversation.permissionMode === "ask");
        await send("ZCode restored approval fixture");
        await page.locator("#conversation").getByText("Fixture ZCode build active.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(errors, []);
        records.push({
          width,
          locale,
          nativeCodexMenu: true,
          grokNativeApprovalMode: true,
          reload: true,
          activeRunFrozen: true,
          switchResetsToAsk: true,
          codexConfirmation: true,
          codexNativePolicies: true,
          zcodeNativeModeReapplied: true,
          errors,
        });
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log("Codex, Grok and ZCode permission settings, persistence and native execution policies passed on PC/H5.");
} finally {
  await app.dispose();
}
