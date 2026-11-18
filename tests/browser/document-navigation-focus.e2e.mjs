import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/document-navigation-focus";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 90000 }),
  records = [];
try {
  for (const [engine, width, locale, driver] of [
    [chromium, 1440, "en", "legacy"],
    [chromium, 1440, "zh-CN", "files"],
    [webkit, 390, "zh-HK", "legacy"],
    [webkit, 320, "zh-TW", "files"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      const auth = await (await context.request.get(app.base + "/api/auth/status")).json();
      const identity =
        auth.authMode +
        ":" +
        (auth.identity?.id || auth.identity?.username || "local") +
        (auth.directoryScope ? ":" + auth.directoryScope : "");
      await context.addInitScript(
        ({ locale, identity }) => {
          if (window === window.top && /^https?:$/.test(location.protocol)) {
            localStorage.setItem("panda-force-browser-identity", identity);
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", "aurora");
            localStorage.setItem("panda-force-sidebar-open", "true");
          }
        },
        { locale, identity },
      );
      const api = async (path, data) => {
        const res =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { headers: { Origin: app.base }, data });
        assert(res.ok(), await res.text());
        return res.json();
      };
      const catalog = await api("/api/projects"),
        input = {
          name: "Focused writing " + locale,
          code: "focus-" + locale.toLowerCase(),
          revision: catalog.revision,
        };
      const result = driver === "legacy" ? app.legacyProject(input) : await api("/api/projects", input),
        project = result.projects.find((p) => p.code === input.code);
      assert(project);
      const tree = await api("/api/project-document-tree?project=" + project.id),
        created = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title: "Focused document",
          locale,
        });
      const id = created.operation.documentId,
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(25000);
      await page.goto(app.base + "/documents?" + new URLSearchParams({ project: project.id, document: id }));
      const surface = page.locator(".document-rich-content");
      await surface.waitFor();
      await page.waitForFunction(() => document.body.classList.contains("document-navigation-focus"));
      assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-hidden")), width >= 768);
      assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "false");
      assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-sidebar-open")), "true");
      if (width >= 768) {
        await page.locator("#workspaceNavigationToggle").focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "true");
        await page.locator("#toggleSidebar").click();
        assert.equal(await page.evaluate(() => localStorage.getItem("panda-force-sidebar-open")), "true");
      }
      if ((await surface.getAttribute("contenteditable")) !== "true")
        await page
          .locator('[data-doc-action="edit"]:visible,[data-authoring-action="reader-edit"]:visible')
          .first()
          .click();
      await page.locator("#documentTitle").fill("Focused edited document " + locale);
      await page
        .locator('.document-rich-content[contenteditable="true"]')
        .fill("Writing remains the main task. " + locale);
      await page.locator('[data-doc-action="preview"]:visible').click();
      await page.locator('.document-rich-content[contenteditable="false"]').waitFor();
      const expected = await page.evaluate(() => globalThis.__pandaForceI18n.t("documents.lastSaved"));
      if (driver === "legacy")
        await page.waitForFunction(
          (text) => document.querySelector("#documentSaveState")?.textContent === text,
          expected,
        );
      else {
        await page.waitForFunction(() => {
          const t = globalThis.__pandaForceI18n.t,
            text = document.querySelector("#documentSaveState")?.textContent;
          return text === t("documents.draftStored") || text === t("documents.versionSaved");
        });
        const save = page.locator('.document-file-commands [data-doc-action="save"]');
        if (await save.isEnabled()) await save.click();
        await page.waitForFunction(
          () =>
            document.querySelector("#documentSaveState")?.textContent ===
            globalThis.__pandaForceI18n.t("documents.versionSaved"),
        );
      }
      const original = await surface.elementHandle();
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert(await original.evaluate((node) => node.isConnected));
      assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "false");
      assert.match(await page.locator("#documentReadTitle").innerText(), /Focused edited/);
      assert.match(await surface.innerText(), /Writing remains/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/reading-${width}-${locale}-${driver}.png` });
      await page.locator(".authoring-workspace-back:visible,.authoring-project-back:visible").first().click();
      await page.waitForURL((url) => url.pathname === "/project");
      assert.equal(await page.evaluate(() => document.body.classList.contains("document-navigation-focus")), false);
      assert.equal(
        await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"),
        width >= 768 ? "true" : "false",
      );
      await page.goBack();
      await surface.waitFor();
      await page.waitForFunction(() => document.body.classList.contains("document-navigation-focus"));
      assert.equal(await page.locator("#workspaceNavigationToggle").getAttribute("aria-expanded"), "false");
      assert.match(await surface.innerText(), /Writing remains/);
      await page.screenshot({ path: `${out}/returned-${width}-${locale}-${driver}.png` });
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        driver,
        focusedNavigation: true,
        preferencePreserved: true,
        editingAndReturn: true,
      });
      console.log("Verified document navigation focus", width, locale, driver);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/verification.json", JSON.stringify({ passed: true, records }, null, 2));
  console.log("Document navigation focus, preferences, editing and return passed in four locales");
} finally {
  await app.dispose();
}
