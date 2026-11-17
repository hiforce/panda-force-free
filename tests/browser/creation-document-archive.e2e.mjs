import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-document-archive";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
    applicationCreation: true,
    models: [
      {
        id: "gpt-fixture",
        model: "gpt-fixture",
        isDefault: true,
        displayName: "Fixture model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  }),
  results = [];
try {
  for (const [engine, width, locale, driver] of [
    [chromium, 1600, "en", "legacy"],
    [webkit, 430, "zh-CN", "files"],
    [webkit, 390, "zh-HK", "legacy"],
    [webkit, 320, "zh-TW", "files"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === top && /^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-theme", "aurora");
          localStorage.setItem("panda-force-locale", language);
        }
      }, locale);
      const api = async (path, body) => {
        const response =
          body === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data: body, headers: { Origin: app.base } });
        assert(response.ok(), `${path}: ${response.status()} ${await response.text()}\n${app.logs()}`);
        return response.json();
      };
      const catalog = await api("/api/projects"),
        input = {
          name: "Archive project " + locale,
          code: "archive-" + locale.toLowerCase(),
          revision: catalog.revision,
        },
        created = driver === "legacy" ? app.legacyProject(input) : await api("/api/projects", input),
        project = created.projects.find((p) => p.code === input.code);
      assert(project?.id);
      app.creationOutput({ projectId: project.id, text: "Original archived requirements " + locale });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      const detail = async (id) =>
        (await api("/api/personal/document-creations/detail?" + new URLSearchParams({ id }))).task;
      const saved = async (id) => {
        let task;
        await waitFor(async () => {
          task = await detail(id);
          if (task.failure) throw Error(task.failure);
          return task.state === "succeeded";
        });
        return task;
      };
      const answer = async () => {
        const question = page.locator(".creation-session-status .user-input-card");
        await question.waitFor();
        await question.locator(".user-input-option").first().click();
        await question.locator(".user-input-submit").click();
      };
      await page.goto(app.base + "/create");
      assert(!(await page.locator("#sessionInspector").isVisible()));
      await page.locator('.creation-skill-discovery [data-skill-id="software-prd"]:enabled').click();
      await page.locator("#prompt").fill("Create requirements and archive them into " + project.name);
      const submission = page.waitForResponse(
        (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const first = (await (await submission).json()).task;
      await page.waitForURL("**/creation/" + first.id + "?creationScope=personal");
      await answer();
      const original = await saved(first.id),
        id = original.artifact.documentId,
        filename = original.artifact.file.path;
      assert.equal(original.artifact.projectId, "personal");
      assert.equal(original.artifact.location.projectId, project.id);
      assert.equal(original.document.projectId, project.id);
      assert.equal(original.document.projectName, project.name);
      assert.equal(original.documentStatus, "available");
      assert.match(await readFile(filename, "utf8"), /Original archived requirements/);
      const sourceTree = await api("/api/personal/project-document-tree?project=personal");
      assert(!sourceTree.nodes.some((n) => n.documentId === id));
      const targetTree = await api("/api/project-document-tree?project=" + project.id);
      assert(targetTree.nodes.some((n) => n.documentId === id));
      if (width < 1081) await page.locator("#sessionInfoButton").click();
      await waitFor(async () =>
        (await page.locator("[data-creation-document-project]").innerText()).includes(project.name),
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await waitFor(
        async () =>
          (await page.locator(`[data-activity-task="${first.id}"]`).getAttribute("data-state")) === "succeeded",
      );
      if (width < 768) await page.locator("[data-creation-document-project]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/archived-${locale}-${width}.png` });
      if (width < 1081) await page.locator('#sessionInspector [data-session-action="close"]').click();
      await page.locator("[data-creation-open]").click();
      await page.waitForURL(
        (url) =>
          url.pathname === "/documents" &&
          url.searchParams.get("project") === project.id &&
          url.searchParams.get("document") === id,
      );
      await page.locator(".document-rich-content").waitFor();
      assert.match(await page.locator(".document-rich-content").innerText(), /Original archived requirements/);
      await page.goBack();
      await page.locator("#prompt").waitFor();
      app.creationOutput({ text: "Original archived requirements " + locale + ". New acceptance criteria." });
      await page.locator("#prompt").fill("Add acceptance criteria to this same document.");
      const continuation = page.waitForResponse(
        (r) => r.url().endsWith("/document-creations/message") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const next = (await (await continuation).json()).task;
      await page.waitForURL("**/creation/" + next.id + "?creationScope=personal");
      await answer();
      const updated = await saved(next.id);
      assert.equal(updated.artifact.projectId, project.id);
      assert.equal(updated.artifact.documentId, id);
      assert.equal(updated.artifact.revision, 2);
      assert.equal(updated.artifact.file.path, filename);
      assert.match(await readFile(filename, "utf8"), /New acceptance criteria/);
      await page.reload();
      await page.locator("#prompt").waitFor();
      assert.equal((await detail(next.id)).document.projectId, project.id);
      const history =
        driver === "legacy"
          ? await api("/api/documents/revisions?id=" + id)
          : await api("/api/project-documents/revisions?" + new URLSearchParams({ project: project.id, id }));
      assert.equal(history.revisions.length, 2);
      await page.evaluate(
        (language) => globalThis.__pandaForceI18n.setPreference(language === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((language) => globalThis.__pandaForceI18n.setPreference(language), locale);
      assert.deepEqual(errors, []);
      results.push({
        locale,
        width,
        driver,
        sourceEntryRemoved: true,
        sameDocument: true,
        historyPreserved: true,
        continuedAfterNavigationAndReload: true,
        portableFileUpdated: true,
        destinationNameVisible: true,
        errors,
      });
      await context.close();
      app.creationOutput(null);
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
  await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
} finally {
  await app.dispose();
}
