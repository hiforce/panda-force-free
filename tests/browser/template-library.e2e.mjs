import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const fixture = await createAppFixture();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(context);
      const api = async (path, data) => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return fixture.legacyProject(data);
        const res =
          data === undefined
            ? await context.request.get(fixture.base + path)
            : await context.request.post(fixture.base + path, { data });
        assert.ok(res.ok(), path + ": " + (await res.text()));
        return res.json();
      };
      const catalog = await api("/api/projects"),
        projects = await api("/api/projects", {
          code: "library-" + width,
          name: "Library fixture",
          revision: catalog.revision,
        }),
        project = projects.projects.find((p) => p.code === "library-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "docs",
        name: "Docs",
        engine: "markdown",
        sourceMode: "managed",
        locale: "en",
      });
      await api("/api/documents", {
        spaceId: space.id,
        path: "article.md",
        title: "Original",
        locale: "en",
        content: "Original source.",
      });
      const page = await context.newPage(),
        errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (req) => {
        if (req.url().includes("must-not-fetch.invalid")) external.push(req.url());
      });
      await page.goto(fixture.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Host draft survives template maintenance.");
      await page.locator('[data-doc-action="packages"]').click();
      await page.locator('[data-package-action="library"]').click();
      const dialog = page.locator("#templateLibraryDialog"),
        button = (name) => dialog.locator(`[data-library-action="${name}"]`);
      const idle = () =>
        page.waitForFunction(
          () => document.querySelector("#templateLibraryDialog")?.getAttribute("aria-busy") === "false",
        );
      await idle();
      await button("new").click();
      await page.locator("#library-id").fill("example.library-" + width);
      await page.locator("#library-name").fill("Library fixture");
      await dialog.locator("[data-library-archive] > summary").click();
      await page.locator("#library-archive-author").fill("Fixture author");
      await page.locator("#library-archive-license").fill("MIT");
      await page.locator("#library-exports").locator("..").locator(":scope > summary").click();
      const exports = JSON.parse(await page.locator("#library-exports").inputValue());
      exports.channelTemplates[0].formats.push("x-post");
      await page.locator("#library-exports").fill(JSON.stringify(exports, null, 2));
      const content =
        "# Preserved sample\n\nA **clear** statement.\n\n> Exact quote.\n\n```js\nconst safe = true;\n```\n\n![External](https://must-not-fetch.invalid/image.png)\n";
      await page.locator("#library-fixture-content").fill(content);
      await page.locator("#library-fixtures").locator("..").locator("summary").click();
      const cases = JSON.parse(await page.locator("#library-fixtures").inputValue());
      assert.equal(cases[0].content, content);
      cases.push({
        ...cases[0],
        id: "sample-zh",
        name: "中文样例",
        locale: "zh-CN",
        title: "中文标题",
        content: "# 中文样例\n\n保留引用与格式。\n",
      });
      cases.push({
        ...cases[0],
        id: "sample-post",
        name: "Post sample",
        format: "x-post",
        title: "Post sample",
        content: "Post **sample** with a [reference](https://example.test/).",
      });
      await page.locator("#library-fixtures").fill(JSON.stringify(cases, null, 2));
      assert.equal(await page.locator("#library-fixture-content").isDisabled(), true);
      await button("save").click();
      await idle();
      assert.equal(await page.locator("#library-fixture-content").inputValue(), content);
      const saved = (await api("/api/template-library")).drafts.find(
        (d) => d.manifest.id === "example.library-" + width,
      );
      assert.equal(saved.fixtureCount, 3);
      for (const id of ["sample-1", "sample-zh", "sample-post"]) {
        await page.locator("#library-fixture").selectOption(id);
        await button("preview").click();
        await idle();
        if (id === "sample-post") {
          assert.match(await dialog.locator(".library-post pre").innerText(), /Post sample/);
          assert.match(await dialog.locator(".library-post header").innerText(), /280/);
          assert.equal(await dialog.locator(".library-preview iframe").count(), 0);
        } else {
          assert.equal(await dialog.locator(".library-preview iframe").getAttribute("sandbox"), "");
          const frame = page.frameLocator("#templateLibraryDialog .library-preview iframe");
          assert.match(await frame.locator("body").innerText(), id === "sample-1" ? /Exact quote/ : /中文样例/);
        }
        await button("baseline").click();
        await idle();
        assert.equal(await page.locator("#library-fixture").inputValue(), id);
      }
      await button("validate").click();
      await idle();
      assert.match(
        await dialog.locator(".library-validation h3").innerText(),
        locale === "zh-CN" ? /校验通过/ : /Validation passed/,
      );
      if (process.env.PANDA_FORCE_TEST_RUN)
        await page.screenshot({ path: `${process.env.PANDA_FORCE_TEST_RUN}/template-library-${width}.png` });
      await button("review").click();
      await idle();
      await page.locator("#libraryPackageAccept").check();
      await page.locator('#libraryPackageApproval [type="submit"]').click();
      await idle();
      const first = (await api("/api/template-library/release?id=example.library-" + width + "&version=1.0.0")).release;
      assert.equal(first.definition.archive.license, "MIT");
      assert.equal(first.validation.passed, true);
      const downloading = page.waitForEvent("download");
      await button("export").click();
      const download = await downloading;
      const exported = JSON.parse(await readFile(await download.path(), "utf8"));
      assert.equal(exported.definition.archive.license, "MIT");
      assert.equal(exported.verification.passed, true);
      await page.locator("#libraryNextVersion").fill("1.0.1");
      await button("fork").click();
      await idle();
      assert.equal(await page.locator("#library-version").inputValue(), "1.0.1");
      await page.locator("#library-name").fill("Unsaved changes retained.");
      await button("close").click();
      assert.equal(await page.locator("#libraryDiscard").isVisible(), true);
      await button("keep").click();
      assert.equal(await page.locator("#library-name").inputValue(), "Unsaved changes retained.");
      await button("close").click();
      await button("discard").click();
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.locator('[data-package-action="library"]').click();
      await idle();
      const codeDefinition = exampleTemplateDefinition();
      codeDefinition.package = exampleThemePackage();
      codeDefinition.package.manifest.id = "example.files-" + width;
      codeDefinition.fixtures = [];
      const binary = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10]);
      codeDefinition.package.files.push({
        path: "hexo/source/sample.png",
        data: binary.toString("base64"),
        sha256: createHash("sha256").update(binary).digest("hex"),
      });
      await page.locator("#libraryImport").setInputFiles({
        name: "theme.template.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ schema: 1, definition: codeDefinition, verification: { passed: true } })),
      });
      await idle();
      await page.locator("#library-file").locator("..").locator(":scope > summary").click();
      await page.locator("#library-file").selectOption("hexo/scripts/helpers.js");
      const code = "// A reviewed source edit.\nhexo.extend.helper.register('sample',()=> '原样保留');\n";
      await page.locator("#library-fileText").fill(code);
      await button("save").click();
      await idle();
      const edited = (await api("/api/template-library")).drafts.find(
          (d) => d.manifest.id === "example.files-" + width,
        ),
        detail = (await api("/api/template-library/draft?id=" + edited.id)).draft;
      const script = detail.definition.package.files.find((f) => f.path === "hexo/scripts/helpers.js");
      assert.equal(Buffer.from(script.data, "base64").toString(), code);
      assert.equal(script.sha256, createHash("sha256").update(code).digest("hex"));
      assert.equal(detail.validation, null);
      assert.equal(
        detail.definition.package.files.find((f) => f.path === "hexo/source/sample.png").data,
        binary.toString("base64"),
      );
      await page.locator("#library-name").fill("Unsaved source edit to discard with this working copy.");
      await button("delete").click();
      await button("confirm-delete").click();
      await idle();
      assert.equal(
        (await api("/api/template-library")).drafts.some((d) => d.id === edited.id),
        false,
      );
      await button("close").click();
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.locator('[data-package-action="close"]').click();
      assert.equal(await page.locator("#documentSource").inputValue(), "Host draft survives template maintenance.");
      assert.deepEqual(
        (await api("/api/template-library/release?id=example.library-" + width + "&version=1.0.0")).release,
        first,
      );
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await context.close();
      console.log(
        `${engine.name()} ${width}: draft editing, matrix preservation, sandboxed previews, explicit baselines, atomic release, version forks and retained host drafts passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
