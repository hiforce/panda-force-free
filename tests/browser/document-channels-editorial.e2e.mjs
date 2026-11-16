import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { unzipSync, strFromU8 } from "fflate";
import { createAppFixture } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/document-channels-editorial";
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width === 390 ? "dark" : "light",
      });
      await app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined) return app.legacyProject(data);
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), method + " " + path + ": " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const created = await api("/api/projects", {
        code: "original-channels-" + width,
        name: "Writing first",
        revision: catalog.revision,
      });
      const project = created.projects.find((value) => value.code === "original-channels-" + width);
      const source = await api("/api/project-documents", {
        projectId: project.id,
        title: "One rich original",
        locale: "en",
      });
      const body = {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { textAlign: "center" },
              content: [
                { type: "text", text: "Words  with spaces.  ", marks: [{ type: "bold" }, { type: "underline" }] },
              ],
            },
            {
              type: "blockquote",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Quotation  protected." }] }],
            },
            {
              type: "codeBlock",
              attrs: { language: "js" },
              content: [{ type: "text", text: "const  protectedText = 1;" }],
            },
          ],
        },
      };
      const saved = await api(
        "/api/documents/detail?id=" + source.document.id,
        { revision: 1, title: "One rich original", locale: "en", body },
        "put",
      );
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/documents?project=" + project.id + "&document=" + source.document.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content").waitFor();
      await page.locator('[data-doc-action="publishing"]').click();
      const manager = page.locator("#documentPublicationDialog"),
        channels = page.locator("#publishingDialog"),
        review = page.locator("#editorialDialog");
      await manager.locator('[data-placement-action="channels"]:not([disabled])').waitFor();
      await manager.locator('[data-placement-action="channels"]').click();
      await channels.locator('[data-pub-action="prepare"]:not([disabled])').waitFor();
      assert.equal(await channels.locator(".publishing-proofread-link").isHidden(), true);
      await channels.locator("#publicationFormat").selectOption("html");
      await channels.locator('[data-pub-action="prepare"]').click();
      await channels.locator("#publicationPreview u").waitFor();
      assert.equal(await channels.locator("#publicationPreview strong u, #publicationPreview u strong").count(), 1);
      assert.match(await channels.locator("#publicationPreview").innerText(), /Words\s+with spaces/);
      if (width === 390) await channels.locator('[data-pub-action="settings"]').click();
      await channels.locator("#publicationFormat").selectOption("x-article");
      await channels.locator('[data-pub-action="prepare"]').click();
      await channels.locator("[data-issue]").first().waitFor();
      const download = page.waitForEvent("download");
      await channels.locator('[data-pub-action="export-bundle"]').click();
      const downloaded = await download,
        files = unzipSync(await readFile(await downloaded.path()));
      assert.deepEqual(JSON.parse(strFromU8(files["source.rich.json"])), saved.revision.body);
      assert.equal(JSON.parse(strFromU8(files["manifest.json"])).source.sourceHash, saved.revision.contentHash);
      await channels.locator('[data-pub-action="close"]').click();
      await manager.locator('[data-placement-action="spacing"]:not([disabled])').waitFor();
      await manager.locator('[data-placement-action="spacing"]').click();
      await review.locator("[data-editorial-edit]").first().waitFor();
      assert.equal(await review.locator("[data-editorial-edit]").count(), 2);
      assert.equal(await review.locator('[data-editorial-action="apply"]').isDisabled(), true);
      await review.locator("[data-editorial-edit]").first().check();
      assert.equal(await review.locator('[data-editorial-action="apply"]').isDisabled(), false);
      for (const size of width === 390 ? [320, 390, 768] : [1440]) {
        await page.setViewportSize({ width: size, height: 960 });
        assert.ok(await review.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
        const button = await review.locator('[data-editorial-action="apply"]').boundingBox();
        assert.ok(button && button.x >= 0 && button.x + button.width <= size + 1);
      }
      await page.setViewportSize({ width, height: 960 });
      if (width > 700) {
        const bounds = await review.boundingBox();
        assert.ok(
          bounds &&
            Math.abs(bounds.x - (width - bounds.width) / 2) < 2 &&
            Math.abs(bounds.y - (960 - bounds.height) / 2) < 2,
        );
      }
      await page.screenshot({ path: out + "/review-" + engine.name() + ".png" });
      let lost = false;
      await page.route("**/api/document-editorial/accept", async (route) => {
        if (!lost) {
          lost = true;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          await route.abort("failed");
        } else await route.continue();
      });
      await review.locator('[data-editorial-action="apply"]').click();
      await page.waitForFunction(() => document.querySelector("#editorialStatus")?.dataset.error === "true");
      const applied = await api("/api/documents/detail?id=" + source.document.id, undefined, "get");
      assert.equal(applied.document.revision, 3);
      assert.equal(await review.locator("[data-editorial-edit]").first().isDisabled(), true);
      assert.match(await review.locator('[data-editorial-action="apply"]').innerText(), /Retry|重试/);
      await review.locator('[data-editorial-action="apply"]').click();
      await review.waitFor({ state: "hidden" });
      await manager.waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document.querySelector(".document-rich-content")?.textContent?.includes("Words with spaces."),
      );
      const retained = await api("/api/documents/detail?id=" + source.document.id, undefined, "get");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-doc-action")), "publishing");
      assert.equal(retained.document.revision, 3);
      assert.equal(retained.revision.body.document.content[0].content[0].text, "Words with spaces.  ");
      assert.deepEqual(
        retained.revision.body.document.content[0].content[0].marks,
        saved.revision.body.document.content[0].content[0].marks,
      );
      assert.deepEqual(retained.revision.body.document.content.slice(1), saved.revision.body.document.content.slice(1));
      await page.locator('[data-doc-action="publishing"]').click();
      await manager.locator('[data-placement-action="spacing"]:not([disabled])').click();
      await review.locator("#editorialHistory option").nth(2).waitFor({ state: "attached" });
      const history = await api("/api/document-editorial?document=" + source.document.id, undefined, "get"),
        prior = history.proposals.find((item) => item.receipt);
      await review.locator("#editorialHistory").selectOption(prior.proposal.id);
      await review.locator(".editorial-state").waitFor();
      assert.equal(await review.locator('[data-editorial-action="apply"]').isDisabled(), true);
      assert.doesNotMatch(await review.innerText(), /editorial\.[a-zA-Z]+/);
      await review.locator('[data-editorial-action="close"]').click();
      await manager.locator('[data-placement-action="close"]:not([disabled])').click();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator(".document-rich-content u").first().waitFor();
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        engine.name() +
          ": original channels, rich exports, selected review, uncertain response retry and persistence passed",
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
