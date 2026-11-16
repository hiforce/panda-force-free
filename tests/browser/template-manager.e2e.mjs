import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { decodeSkillBundle } from "../../src/server/skills/storage/codec.js";
import { portableFixture, fixtureBytes, editPortableFixture } from "../support/portable-templates.js";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";

const fixture = await createAppFixture();
await mkdir(".artifacts/template-manager", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(context);
      page = await context.newPage();
      await page.emulateMedia({ colorScheme: locale === "en" ? "light" : "dark" });
      const errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (req) => {
        if (/^https?:/.test(req.url()) && !req.url().startsWith(fixture.base)) external.push(req.url());
      });
      await page.goto(fixture.base + "/publish/website");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const center = page.locator(".template-manager"),
        detail = page.locator("#managedTemplateDialog"),
        importer = page.locator("#managedTemplateImport");
      await center.locator(".template-card").first().waitFor();
      assert.equal(await center.locator('[data-template-action="more"]').isVisible(), false);
      assert.equal(await center.locator("h1").textContent(), locale === "en" ? "Site themes" : "站点主题");
      await center.locator('[data-template-key^="builtin:site-theme:panda.journal:"]').click();
      await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
      await detail.locator('[data-template-detail="preview"]').click();
      if (await detail.locator(".template-static-sample > summary").isVisible())
        await detail.locator(".template-static-sample > summary").click();
      await detail.locator("iframe").waitFor();
      assert.equal(await detail.locator("iframe").getAttribute("sandbox"), "");
      assert.match(await detail.locator("iframe").getAttribute("srcdoc"), /Georgia,serif/);
      await detail.locator('[data-template-detail="versions"]').click();
      await detail.locator(".template-version-row").waitFor();
      assert.equal(await detail.locator(".template-version-row").count(), 1);
      assert.equal(await detail.locator('[data-template-detail="edit"]').isVisible(), false);
      await detail.locator('[data-template-detail="close"]').click();

      const pkg = exampleThemePackage();
      pkg.manifest.id = "example.manager-" + width;
      async function upload(content, name, selected) {
        await center.locator('[data-template-action="import"]').click();
        await importer
          .locator("[data-import-file]")
          .setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(content) });
        await importer.locator("[data-template-export]").first().waitFor();
        await importer.locator('[data-import-action="review"]:enabled').waitFor();
        for (const input of await importer.locator("[data-template-export]").all())
          await input.setChecked(selected.includes(await input.inputValue()));
        await importer.locator('[data-import-action="review"]').click();
        await importer.locator("#managedImportAccept:enabled").waitFor();
        await importer.locator("#managedImportAccept").check();
        const pending = page.waitForResponse(
          (res) => res.url().endsWith("/install") && res.request().method() === "POST",
        );
        await importer.locator('#managedImportApproval button[type="submit"]').click();
        const installed = await pending;
        assert.equal(installed.status(), 201, await installed.text());
        await importer.locator('[data-import-action="close"]').click();
      }
      await upload(JSON.stringify(pkg), "publishing.json", ["channel-template:paper"]);
      const packages = await (await context.request.get(fixture.base + "/api/document-packages")).json();
      const installed = packages.packages.find((item) => item.id === pkg.manifest.id);
      assert.deepEqual(installed.grants, ["content:templates"]);
      assert.deepEqual(installed.exports, [{ kind: "channel-template", id: "paper", enabled: true, active: true }]);
      await page.goto(fixture.base + "/publish/x");
      await page.locator('[data-publish-format="x-article"]').click();
      await center.locator("[data-template-search]").fill(pkg.manifest.id);
      await center.locator(`[data-template-key*="${pkg.manifest.id}"]`).waitFor();
      await center.locator(`[data-template-key*="${pkg.manifest.id}"]`).click();
      await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
      await detail.locator('[data-template-detail="preview"]').click();
      await detail.locator("iframe").waitFor();
      const pending = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const exported = JSON.parse(await readFile(await (await pending).path(), "utf8"));
      assert.equal((await verifyPluginPackage(exported)).digest, installed.digest);
      assert.equal(exported.files.length, pkg.files.length);
      await detail.locator('[data-template-detail="toggle"]').click();
      await detail.waitFor({ state: "hidden" });
      await center.locator('.template-state[data-enabled="false"]').waitFor();

      const newer = exampleThemePackage("2.0.0");
      newer.manifest.id = pkg.manifest.id;
      await upload(JSON.stringify(newer), "publishing-v2.json", ["channel-template:paper"]);
      await center.locator(`[data-template-key*="${pkg.manifest.id}:paper:2.0.0:"]`).click();
      await detail.locator('[data-template-detail="versions"]:enabled').waitFor();
      await detail.locator('[data-template-detail="versions"]').click();
      await detail.locator(".template-version-row").nth(1).waitFor();
      assert.equal(await detail.locator(".template-version-row").count(), 2);
      await detail.locator('[data-template-version*=":1.0.0:"]').click();
      await detail.locator('[data-template-detail="toggle"]:enabled').waitFor();
      assert.match(await detail.locator("[data-template-overview] details code").first().textContent(), /@1\.0\.0$/);
      await detail.locator('[data-template-detail="toggle"]').click();
      await detail.waitFor({ state: "hidden" });
      await center.locator(`[data-template-key*="${pkg.manifest.id}:paper:2.0.0:"]`).click();
      await detail.locator('[data-template-detail="versions"]:enabled').click();
      await detail.locator('[data-template-version*="1.0.0"]').click();
      await detail.locator('[data-template-detail="activate"]:enabled').waitFor();
      await detail.locator('[data-template-detail="activate"]').click();
      await detail.waitFor({ state: "hidden" });
      const rolledBack = (
        await (await context.request.get(fixture.base + "/api/document-packages")).json()
      ).packages.filter((item) => item.id === pkg.manifest.id);
      assert.equal(rolledBack.find((item) => item.version === "1.0.0").exports[0].active, true);
      assert.equal(rolledBack.find((item) => item.version === "2.0.0").exports[0].active, false);

      const skill = await nativeSkillPackage("example.writing-" + width);
      await upload(skill.content, "writing.skill.json", ["blog-outline"]);
      await page.goto(fixture.base + "/skills/writing");
      await center.locator("[data-template-search]").fill(skill.pack.manifest.id);
      await center.locator(`[data-template-key*="${skill.pack.manifest.id}:blog-outline:"]`).waitFor();
      await center.locator(`[data-template-key*="${skill.pack.manifest.id}:blog-outline:"]`).click();
      await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
      await detail.locator('[data-template-detail="preview"]').click();
      await detail.locator("iframe").waitFor();
      assert.match(await detail.locator("iframe").getAttribute("srcdoc"), /Approach and examples/);
      assert.equal(await detail.locator('[data-template-detail="edit"]').isVisible(), false);
      const skillPending = page.waitForEvent("download");
      await detail.locator('[data-template-detail="export"]').click();
      const downloaded = await skillPending;
      assert.equal(
        (await decodeSkillBundle(new Uint8Array(await readFile(await downloaded.path())))).digest,
        skill.pack.digest,
      );
      const bounds = await detail.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
      await page.screenshot({ path: `.artifacts/template-manager/detail-${width}.png` });
      await detail.locator('[data-template-detail="toggle"]').click();
      await detail.waitFor({ state: "hidden" });
      await center
        .locator(`[data-template-key*="${skill.pack.manifest.id}:blog-outline:"] .template-state[data-enabled="false"]`)
        .waitFor();
      await center.locator("[data-template-search]").fill("");
      const portable = await portableFixture();
      for (const id of portable.index.entries.map((item) => item.id))
        await editPortableFixture(portable, id, (manifest) => {
          manifest.id += "-" + width;
        });
      const articleId = "example.article-outline-" + width,
        slidesId = "example.brand-slides-" + width,
        siteId = "example.site-reader-" + width;
      await upload(new TextDecoder().decode(fixtureBytes(portable)), "mixed.templates.json", [
        articleId + "@1.0.0",
        slidesId + "@1.0.0",
      ]);
      const all = await (await context.request.get(fixture.base + "/api/template-catalog?limit=100")).json();
      assert.equal(
        all.templates.filter(
          (item) => item.reference.registry === "portable" && item.reference.id.endsWith("-" + width),
        ).length,
        2,
      );
      await upload(new TextDecoder().decode(fixtureBytes(portable)), "mixed.templates.json", [siteId + "@1.0.0"]);
      for (const [id, type, pattern] of [
        [articleId, "panda.document-template", /Why it matters/],
        [slidesId, "panda.slides-template", /data-slide-layout="title"/],
        [siteId, "panda.site-theme", /max-width:940px/],
      ]) {
        await page.goto(
          fixture.base +
            {
              "panda.document-template": "/skills/writing",
              "panda.slides-template": "/skills/slides",
              "panda.site-theme": "/publish/website",
            }[type],
        );
        await center.locator("[data-template-search]").fill(id);
        if (type === "panda.site-theme") {
          await page.waitForFunction(
            () => document.querySelector(".template-manager")?.getAttribute("aria-busy") === "false",
          );
          assert.equal(await center.locator(`[data-template-key^="portable:template:${id}:"]`).count(), 0);
          await page.locator('[data-publish-format="all"]').click();
          await center.locator("[data-template-search]").fill(id);
        }
        await center.locator(`[data-template-key^="portable:template:${id}:"]`).waitFor();
        await center.locator(`[data-template-key^="portable:template:${id}:"]`).click();
        await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
        await detail.locator('[data-template-detail="versions"]').click();
        await detail.locator(".template-version-row").waitFor();
        assert.equal(await detail.locator(".template-version-row").count(), 1);
        await detail.locator('[data-template-detail="preview"]').click();
        await detail.locator("iframe").waitFor();
        assert.equal(await detail.locator("iframe").getAttribute("sandbox"), "");
        assert.match(await detail.locator("iframe").getAttribute("srcdoc"), pattern);
        assert.equal(
          await detail.locator('[data-template-detail="edit"]').isVisible(),
          type === "panda.document-template",
        );
        const downloaded = page.waitForEvent("download");
        await detail.locator('[data-template-detail="export"]').click();
        const roundtrip = await parsePortableTemplateBundle(
          new Uint8Array(await readFile(await (await downloaded).path())),
        );
        assert.equal(roundtrip.templates.length, 1);
        assert.equal(roundtrip.templates[0].manifest.id, id);
        await page.screenshot({ path: `.artifacts/template-manager/portable-${type}-${width}.png` });
        await detail.locator('[data-template-detail="toggle"]').click();
        await detail.waitFor({ state: "hidden" });
        await center.locator('.template-state[data-enabled="false"]').waitFor();
      }
      await center.locator("[data-template-search]").fill("");
      await center.locator('[data-template-action="refresh"]:enabled').waitFor();
      await page.screenshot({ path: `.artifacts/template-manager/gallery-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(
        `${engine.name()} ${width}: compatibility and portable mixed import, lifecycle, version list and typed structure previews passed`,
      );
    } catch (error) {
      if (page) await page.screenshot({ path: `.artifacts/template-manager/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
