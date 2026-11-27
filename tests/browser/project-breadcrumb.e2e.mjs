import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const f = await createAppFixture(),
  out = ".artifacts/project-breadcrumb/browser",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN" });
    try {
      await f.signIn(context);
      await context.addInitScript(() => {
        try {
          localStorage.setItem("panda-force-theme", "aurora");
        } catch {}
      });
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await context.request.get(f.base + path)
            : await context.request.post(f.base + path, { data });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const initial = await api("/api/projects"),
        snapshot = f.legacyProject({
          name: "PandaForce",
          code: "panda-force-breadcrumb-" + width,
          description: "围绕项目整理想法、文档与会话。",
          revision: initial.revision,
        }),
        project = snapshot.projects.find((p) => p.code === "panda-force-breadcrumb-" + width),
        base = "/project?id=" + project.id;
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.base + base);
      const openComposer = async () => {
        await page.locator(".project-create-menu > summary").click();
        await page.locator("[data-project-compose]").click();
        await page.locator("#gadgetDocumentPrompt:visible").waitFor();
      };
      await openComposer();
      const verify = async (name) => {
        const crumb = page.locator(".project-breadcrumb"),
          heading = page.locator("[data-creative-heading]");
        assert.equal(await crumb.count(), 1);
        assert.equal(await page.locator(".project-overview-back,.project-overview-symbol").count(), 0);
        assert.equal(await crumb.locator("a").getAttribute("href"), "/projects");
        assert.equal(await heading.textContent(), name);
        const a = await crumb.boundingBox(),
          b = await heading.boundingBox();
        assert.ok(a.x + a.width <= b.x + 1, "The project list control and title share a row");
        assert.ok(Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 2);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      };
      await verify(project.name);
      await page.locator("#gadgetDocumentPrompt").fill("Keep this draft while I return to the project list.");
      await page.locator(".project-breadcrumb a").focus();
      await page.keyboard.press("Enter");
      await page.locator(`.project-directory-main[href="${base}"]`).waitFor();
      await page.locator(`.project-directory-main[href="${base}"]`).click();
      await openComposer();
      assert.equal(
        await page.locator("#gadgetDocumentPrompt").inputValue(),
        "Keep this draft while I return to the project list.",
      );
      await page.screenshot({ path: `${out}/content-${width}.png` });
      for (const [section, href, ready] of [
        ["documents", base + "&tab=documents", ".project-creation-documents"],
        ["sessions", base + "&tab=sessions", ".project-sessions-view"],
        ["publish", "/publish?project=" + project.id, ".project-publish-view"],
      ]) {
        await page.locator(`a[href="${href}"]`).first().click();
        await page.locator(ready).waitFor();
        await verify(project.name);
        await page.screenshot({ path: `${out}/${section}-${width}.png` });
      }
      await page.locator(`.resource-project-tabs a[href="${base}"]`).click();
      await page.locator("[data-wb=project-edit]").click();
      const longName = "PandaForce · 项目空间与产品内容协作设计";
      await page.locator("#projectNameInput").fill(longName);
      await page.locator("#projectForm [type=submit]").click();
      await page.locator("[data-project-breadcrumb-current]").filter({ hasText: longName }).waitFor();
      for (const [locale, label] of [
        ["en", "Projects"],
        ["zh-CN", "项目"],
        ["zh-HK", "項目"],
        ["zh-TW", "專案"],
      ]) {
        await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), locale);
        await page.locator(".project-breadcrumb a").filter({ hasText: label }).waitFor();
        await verify(longName);
        assert.equal(await page.locator("[data-project-breadcrumb-current]").getAttribute("title"), longName);
        await page.screenshot({ path: `${out}/long-${locale}-${width}.png` });
      }
      assert.deepEqual(errors, []);
      records.push({
        width,
        backAndTitleShareRow: true,
        allProjectSections: true,
        keyboardParentNavigation: true,
        draftPreserved: true,
        renamedProjectSynced: true,
        longNameAndFourLocales: true,
        noHorizontalOverflow: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    out + "/results.json",
    JSON.stringify({ passed: true, records, modelInferenceRequested: false }, null, 2),
  );
} finally {
  await f.dispose();
}
