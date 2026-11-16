import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "panda-profile-browser-")),
  fixture = await createSiteBuildFixture({ workspaceDirectory: root });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.app.signIn(context);
      const api = async (path, data, method = data === undefined ? "get" : "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const res = await context.request[method](fixture.app.base + path, { data });
        assert.ok(res.ok(), path + ": " + (await res.text()));
        return res.json();
      };
      const source = join(root, "blog-" + width);
      const put = async (path, bytes) => {
        await mkdir(join(source, path, ".."), { recursive: true });
        await writeFile(join(source, path), bytes);
      };
      await put("package.json", JSON.stringify({ dependencies: { hexo: "8.1.1" } }));
      await put(
        "_config.base.yml",
        "title: Original public journal\nurl: https://example.test\ndeploy:\n  password: never-expose-this-value\ntheme_config:\n  label: Public label\n  api_key: never-copy-this-value\n",
      );
      await put("_config.en.yml", "root: /journal/\nblog_language: en\n");
      await put(
        "source-en/_posts/essay.md",
        '---\ntitle: Saved article\nslug: essay\ncover: diagram.png\n---\n{% figure "/assets/articles/essay/diagram.png" "Figure" %}\nA saved caption.\n{% endfigure %}\n',
      );
      const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } })
        .png()
        .toBuffer();
      await put("assets/articles/essay/diagram-en.png", png);
      await put("assets/articles/essay/diagram-en.webp", await sharp(png).webp().toBuffer());
      await put("themes/journal/layout/layout.ejs", "<!doctype html><html><body><%- body %></body></html>");
      await put("themes/journal/layout/index.ejs", "<% page.posts.each(post=>{ %><h1><%= post.title %></h1><% }) %>");
      const catalog = await api("/api/projects"),
        result = await api("/api/projects", {
          name: "Source profiles",
          code: "profiles-" + width,
          revision: catalog.revision,
        }),
        project = result.projects.find((p) => p.code === "profiles-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "blog",
        name: "Source journal",
        engine: "hexo",
        sourceMode: "external",
        sourceRoot: source,
        locale: "en",
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator('[data-doc-action="source-profile"]').click();
      const dialog = page.locator("#documentDialog");
      await page.locator('[name="document-config-0"]').check();
      await page.locator('[name="document-config-1"]').check();
      await page.locator('[name="document-webp"]').check();
      await dialog.locator('[type="submit"]').click();
      await page.locator("#doc-profile").waitFor();
      const profile = JSON.parse(await page.locator("#doc-profile").inputValue());
      assert.equal(profile.editions.en.basePath, "/journal/");
      assert.equal(profile.imageMode, "source-webp");
      assert.doesNotMatch(JSON.stringify(profile), /never-copy|never-expose|password|api_key/);
      assert.doesNotMatch(await dialog.innerText(), /documents\.source/);
      if (process.env.PANDA_FORCE_TEST_RUN)
        await page.screenshot({ path: `${process.env.PANDA_FORCE_TEST_RUN}/source-profile-${width}.png` });
      await dialog.locator('[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      await page.locator('[data-doc-action="scan"]').click();
      await page.locator(".document-file").waitFor();
      await page.locator(".document-file").click();
      await page.locator("#documentSource").fill("Unsaved draft survives source theme packaging.");
      await page.locator('[data-doc-action="source-theme"]').click();
      await page.locator("#doc-id").fill("example.source-" + width);
      await dialog.locator('[type="submit"]').click();
      const packages = page.locator("#documentPackageDialog");
      await page.locator("#packageApproval").waitFor();
      assert.doesNotMatch(await packages.innerText(), /plugins\.(?:package|permission)/);
      await page.locator("#packageAccept").check();
      await page.locator('#packageApproval [type="submit"]').click();
      await page.waitForFunction(
        () =>
          !document.querySelector("#packageApproval") &&
          document.querySelector("#documentPackageDialog")?.getAttribute("aria-busy") === "false",
      );
      await page.locator('[data-package-action="close"]').click();
      assert.equal(
        await page.locator("#documentSource").inputValue(),
        "Unsaved draft survives source theme packaging.",
      );
      await page.locator('[data-doc-action="theme"]').click();
      await page.locator("#doc-theme").selectOption(`example.source-${width}.site@1.0.0`);
      await dialog.locator('[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      await page.locator('[data-doc-action="build"]').click();
      await page.waitForFunction(() => document.querySelector("#build-url")?.value === "https://example.test");
      assert.equal(await page.locator("#build-basePath").inputValue(), "/journal/");
      assert.equal(await page.locator("#build-title").inputValue(), "Original public journal");
      await page.locator("#build-locale").fill("fr");
      await page.locator("#build-locale").dispatchEvent("change");
      assert.equal(await page.locator("#createSiteBuild").isDisabled(), true);
      await page.locator("#build-locale").fill("en");
      await page.locator("#build-locale").dispatchEvent("change");
      await page.locator("#createSiteBuild").click();
      await waitFor(
        () => [...fixture.inputs.values()].some((input) => input.theme?.id === `example.source-${width}.site`),
        "source profile reaches executor",
      );
      const captured = [...fixture.inputs.values()].find((input) => input.theme?.id === `example.source-${width}.site`);
      assert.equal(captured.project.config.blog_language, "en");
      assert.equal(captured.site.basePath, "/journal/");
      assert.match(captured.documents[0].content, /diagram-en.png/);
      await page.locator('[data-build-action="snapshot"]').click();
      assert.match(
        await page.locator(".builds-source-snapshot").innerText(),
        locale === "zh-CN" ? /源项目快照/ : /Source project snapshot/,
      );
      await page.locator(".builds-source-snapshot details").first().locator("summary").click();
      assert.match(await page.locator(".builds-source-snapshot pre").innerText(), /"blog_language": "en"/);
      assert.equal((await api("/api/document-spaces/source-profile?id=" + space.id)).profile.imageMode, "source-webp");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `${engine.name()} ${width}: public profile review, safe source packaging, explicit approval, retained drafts and edition build defaults passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
  await rm(root, { recursive: true, force: true });
}
