import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_ENCRYPTION_KEYS_PROOF || ".artifacts/encryption-keys";
await mkdir(proof, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "light"],
    [chromium, 1180, "zh-CN", "aurora"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "light"],
  ]) {
    const mobile = width < 768;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 840 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme === "aurora" ? "dark" : "light",
        acceptDownloads: true,
      });
      await app.signIn(context);
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window !== window.top) return;
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        },
        { locale, theme },
      );
      const messages = JSON.parse(
        await readFile(new URL(`../../src/shared/i18n/locales/${locale}/settings.json`, import.meta.url), "utf8"),
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const activate = (control) => (mobile ? control.tap() : control.click());
      const keyPage = page.locator('[data-settings-content="encryption-keys"]');
      const create = keyPage.locator("[data-open-key-create]");
      const restore = keyPage.locator("[data-open-key-restore]");
      const modal = page.locator("dialog.encryption-key-dialog[open]");
      const empty = keyPage.getByRole("heading", { name: messages.encryptionKeyEmpty, exact: true });
      const shot = (name) => page.screenshot({ path: join(proof, `${name}-${locale}-${width}.png`) });
      const path = app.base + "/settings/encryption-keys";

      await page.goto(path);
      await empty.waitFor();
      await page.locator(".topbar .window-brand").waitFor();
      if (mobile) {
        const back = await keyPage.locator("[data-settings-mobile-back]").boundingBox();
        const heading = await keyPage.locator("h1").boundingBox();
        assert(heading.x < back.x + back.width + 32);
      }
      await shot("empty");
      for (const button of [create, restore]) {
        assert((await button.boundingBox()).height >= (mobile ? 44 : 40));
      }

      await activate(create);
      await modal.getByRole("heading", { name: messages.encryptionKeyCreate, exact: true }).waitFor();
      const passphrase = "encryption settings fixture phrase";
      const password = modal.locator('[name="password"]');
      const repeat = modal.locator('[name="repeat"]');
      const submit = modal.locator("button[type=submit]");
      const status = modal.locator("[data-key-dialog-status]");
      await modal.locator('[name="keyName"]').fill("Project backup");
      await password.fill(passphrase);
      await repeat.fill("invalid fixture confirmation");
      await activate(submit);
      await status.getByText(messages.encryptionKeyPassphraseMismatch, { exact: true }).waitFor();
      assert.equal(await password.inputValue(), passphrase);
      await repeat.fill(passphrase);
      await shot("generate");
      const downloaded = page.waitForEvent("download");
      await activate(submit);
      const keyDownload = await downloaded;
      const backupFile = join(proof, keyDownload.suggestedFilename());
      assert.match(backupFile, /\.pfkey$/);
      await keyDownload.saveAs(backupFile);
      await modal.waitFor({ state: "hidden" });
      await keyPage.getByText(messages.encryptionKeyCreated, { exact: true }).waitFor();
      const key = JSON.parse(await readFile(backupFile, "utf8"));
      assert.equal(key.format, "panda-encryption-key/v1");
      assert.equal(key.name, "Project backup");
      assert(!JSON.stringify(key).includes(passphrase));
      const row = keyPage.locator(".encryption-key-row");
      assert.equal(await row.count(), 1);
      assert.equal(await row.locator("code").getAttribute("title"), key.fingerprint);
      await shot("populated");
      await page.reload();
      const again = page.waitForEvent("download");
      await activate(keyPage.locator("[data-key-backup]"));
      assert.equal((await again).suggestedFilename(), keyDownload.suggestedFilename());

      await page.evaluate(() => localStorage.removeItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey));
      await page.reload();
      await empty.waitFor();
      await activate(restore);
      await modal.getByRole("heading", { name: messages.encryptionKeyRestore, exact: true }).waitFor();
      const choosing = page.waitForEvent("filechooser");
      const choose = modal.locator("[data-key-choose]");
      await choose.focus();
      await page.keyboard.press("Enter");
      await (await choosing).setFiles({ name: "wrong.json", mimeType: "application/json", buffer: Buffer.from("{}") });
      await password.fill(passphrase);
      await activate(submit);
      await status.getByText(messages.encryptionKeyBackupInvalid, { exact: true }).waitFor();
      const fileField = modal.locator("input[type=file]");
      assert.equal(await fileField.getAttribute("accept"), ".pfkey");
      await fileField.setInputFiles(backupFile);
      await modal.locator("[data-key-file]").getByText(keyDownload.suggestedFilename(), { exact: true }).waitFor();
      await password.fill("a different fixture passphrase");
      await activate(submit);
      await status.getByText(messages.encryptionKeyError, { exact: true }).waitFor();
      await password.fill(passphrase);
      await shot("restore");
      await activate(submit);
      await modal.waitFor({ state: "hidden" });
      await keyPage.getByText(messages.encryptionKeyRestored, { exact: true }).waitFor();
      assert.equal(await row.locator("code").getAttribute("title"), key.fingerprint);
      await activate(create);
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-open-key-create"));

      const fallbackLocale = locale === "en" ? "zh-CN" : "en";
      const fallback = JSON.parse(
        await readFile(
          new URL(`../../src/shared/i18n/locales/${fallbackLocale}/settings.json`, import.meta.url),
          "utf8",
        ),
      );
      await page.evaluate((language) => globalThis.__pandaForceI18n.setPreference(language), fallbackLocale);
      await keyPage.getByRole("heading", { name: fallback.encryptionKeyList, exact: true }).waitFor();
      assert.equal(await row.getByRole("heading").textContent(), key.name);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`${locale} ${width}: key creation, backup download, restore retry, layout and localization verified`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
