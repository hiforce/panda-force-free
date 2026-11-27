import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const f = await createAppFixture(),
  out = ".artifacts/project-space-ai/directory-recovery",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-HK"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await f.signIn(context);
      const data = f.legacyProject({ name: "Directory recovery", code: "directory-recovery-" + width }),
        project = data.projects.find((p) => p.code === "directory-recovery-" + width).id;
      const r = await context.request.post(f.base + "/api/project-document-tree/documents", {
        data: {
          id: randomUUID(),
          projectId: project,
          treeVersion: 0,
          title: "Release notes",
          parentId: null,
          locale: "en",
        },
      });
      assert.ok(r.ok(), await r.text());
      const root = await r.json();
      const child = await context.request.post(f.base + "/api/project-document-tree/documents", {
        data: {
          id: randomUUID(),
          projectId: project,
          treeVersion: root.tree.version,
          title: "Child release",
          parentId: root.operation.documentId,
          locale: "en",
        },
      });
      assert.ok(child.ok(), await child.text());
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let fail = true;
      await page.route("**/api/project-document-tree?**", (route) =>
        fail
          ? route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: { code: "documents.unavailable" } }),
            })
          : route.continue(),
      );
      await page.goto(f.base + "/project?id=" + project + "&tab=documents");
      await page.locator('[data-authoring-action="reload-workspace"]').waitFor();
      assert.equal(
        await page.locator(".document-tree-empty").count(),
        0,
        "Failed reads must not appear as an empty document directory",
      );
      fail = false;
      await page.locator('[data-authoring-action="reload-workspace"]').focus();
      await page.keyboard.press("Enter");
      await page.locator(".document-tree-row").nth(1).waitFor();
      await page.locator("#documentSearch").fill("");
      await page.locator(".document-tree-expand:enabled").focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".document-tree-row").count(), 1);
      assert.equal(
        await page.locator(".document-tree-expand:enabled").evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".document-tree-row").count(), 2);
      await page.locator("#documentSearch").fill("Missing title");
      await page.locator(".document-tree-empty").waitFor();
      assert.equal(await page.locator('[data-authoring-action="reload-workspace"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        failedReadNotEmpty: true,
        keyboardRetry: true,
        trueNoMatches: true,
        noHorizontalOverflow: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ passed: true, records }, null, 2));
} finally {
  await f.dispose();
}
