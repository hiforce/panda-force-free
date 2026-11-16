import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { waitFor } from "../support/app-fixture.mjs";

const fixture = await createSiteBuildFixture();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.app.signIn(context);
      const api = async (path, data) => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const response =
          data === undefined
            ? await context.request.get(fixture.app.base + path)
            : await context.request.post(fixture.app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const state = await api("/api/projects"),
        result = await api("/api/projects", {
          name: "Theme packages",
          code: "packages-" + width,
          revision: state.revision,
        }),
        project = result.projects.find((item) => item.code === "packages-" + width),
        { space } = await api("/api/document-spaces", {
          projectId: project.id,
          code: "blog",
          name: "Blog",
          engine: "hexo",
          sourceMode: "managed",
          locale: "en",
        });
      await api("/api/documents", {
        spaceId: space.id,
        path: "article.md",
        title: "Article",
        content: "Saved source.",
        locale: "en",
      });
      const page = await context.newPage(),
        errors = [];
      const value = exampleThemePackage();
      value.manifest.id = "example.studio-" + width;
      const reference = value.manifest.id + ".journal@1.0.0";
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Unsaved source survives package management.");
      await page.locator('[data-doc-action="packages"]').click();
      const dialog = page.locator("#documentPackageDialog");
      await page.waitForFunction(
        () => document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.locator("#packageFile").setInputFiles({
        name: "studio.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
      await page.locator('[data-package-action="review"]').click();
      await page.locator("#packageApproval").waitFor();
      assert.doesNotMatch(await dialog.innerText(), /plugins\.(?:title|permission|accept|review)/);
      assert.match(await dialog.innerText(), locale === "zh-CN" ? /示例主题/ : /Studio/);
      await page.locator("#packageAccept").check();
      const closeBox = await page.locator('[data-package-action="close"]').boundingBox();
      assert.ok(closeBox.width >= 60 && closeBox.height >= 40 && closeBox.y >= 0 && closeBox.y < 960);
      if (process.env.PANDA_FORCE_TEST_RUN)
        await page.screenshot({ path: `${process.env.PANDA_FORCE_TEST_RUN}/packages-${width}.png` });
      await page.locator('#packageApproval [type="submit"]').click();
      await page
        .locator(".package-version")
        .filter({ hasText: value.manifest.id + "@1.0.0" })
        .waitFor();
      await page.waitForFunction(
        () => document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 2));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      const box = await dialog.boundingBox();
      if (width > 700) assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2);
      await page.locator('[data-package-action="close"]').click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsaved source survives package management.");
      await page.locator('[data-doc-action="theme"]').click();
      await page.locator("#doc-theme").selectOption(reference);
      assert.match(
        await page.locator("#documentThemeDescription").innerText(),
        locale === "zh-CN" ? /隔离/ : /isolated/,
      );
      await page.locator('#documentDialog [type="submit"]').click();
      await page.locator("#documentDialog").waitFor({ state: "hidden" });
      await page.locator('[data-doc-action="build"]').click();
      await page.waitForFunction(() => document.querySelector("#createSiteBuild")?.disabled === false);
      await page.locator("#createSiteBuild").click();
      const jobs = await waitFor(async () => {
        const { builds } = await api("/api/site-builds?space=" + space.id);
        return builds.length ? builds : null;
      });
      assert.equal(jobs[0].theme.schema, 2);
      assert.equal(jobs[0].theme.bundle, undefined);
      await waitFor(() => fixture.inputs.has(jobs[0].id));
      assert.equal(fixture.inputs.get(jobs[0].id).theme.bundle.manifest.version, "1.0.0");
      await page.locator('[data-build-action="close"]').click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Unsaved source survives package management.");
      await page.locator('[data-doc-action="packages"]').click();
      await page
        .locator(".package-version")
        .filter({ hasText: value.manifest.id + "@1.0.0" })
        .waitFor();
      await page.waitForFunction(
        () => document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.locator(`[data-package-action="disable"][data-package-id="${value.manifest.id}"]`).click();
      await page.locator(`[data-package-action="enable"][data-package-id="${value.manifest.id}"]`).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log("Package review/install/disable, frozen builds, draft preservation and PC/H5 localization passed.");
} finally {
  await fixture.dispose();
}
