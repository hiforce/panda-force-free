import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const app = await createAppFixture(),
  out = ".artifacts/writing-skill-loading";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale: width < 700 ? "zh-CN" : "en",
        colorScheme: width < 700 ? "dark" : "light",
      });
    try {
      await context.addInitScript(
        (theme) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
        },
        width < 700 ? "dark" : "light",
      );
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let failed = false,
        imports = 0;
      await page.route("**/document-rich-runtime.bundle.js", async (route) => {
        if (route.request().resourceType() === "script") {
          imports++;
          if (!failed) {
            failed = true;
            await route.abort("failed");
            return;
          }
        }
        await route.continue();
      });
      await page.goto(app.base + "/skills/writing");
      const create = page.locator('[data-template-action="article"]');
      await create.waitFor();
      assert.equal((await create.textContent()).trim(), width < 700 ? "新建技能" : "New skill");
      await create.click();
      const editor = page.locator("#templateAuthoringEditor");
      await editor.locator('.document-runtime-status[role="alert"]').waitFor();
      await page.screenshot({ path: `${out}/network-failure-${width}.png` });
      const retry = editor.locator('.document-runtime-status[role="alert"] button');
      assert.equal(
        await retry.count(),
        1,
        "A native module download failure after preparation must remain retryable without refreshing",
      );
      if ((await editor.locator("[data-authoring-layout]").getAttribute("data-panel")) !== "true")
        await editor.locator('[data-authoring-action="settings"]').click();
      await editor.locator('[data-field="name-en"]').fill("Preserved writing skill");
      if (width < 700) await editor.locator('[data-authoring-action="settings"]').click();
      await retry.click();
      await editor.locator('.document-rich-content[contenteditable="true"]').waitFor();
      if (width < 700) await editor.locator('[data-authoring-action="settings"]').click();
      assert.equal(await editor.locator('[data-field="name-en"]').inputValue(), "Preserved writing skill");
      if (width < 700) await editor.locator('[data-authoring-action="settings"]').click();
      assert.ok(failed);
      assert.ok(imports === 1, "Recovery must use a fresh module URL rather than reimport the failed entry");
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/recovered-${width}.png` });
      await editor.locator('[data-authoring-action="close"]').click();
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log(
    "Cold PC/H5 writing skill module failure recovers without refreshing, preserves draft fields and uses unified skill labels.",
  );
} finally {
  await app.dispose();
}
