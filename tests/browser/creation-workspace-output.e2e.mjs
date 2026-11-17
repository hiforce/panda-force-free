import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fileMove = process.env.PANDA_FORCE_TEST_CREATION_FILE_MOVE === "true";
const out = fileMove ? ".artifacts/creation-code-directory" : ".artifacts/creation-workspace-output";
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
const docs = join(app.alpha, "docs");
if (fileMove) await mkdir(docs);
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript(() => {
        if (window === top && /^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "aurora");
      });
      await app.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      const detail = async (id) => {
        const response = await context.request.get(
          app.base + "/api/personal/document-creations/detail?" + new URLSearchParams({ id }),
        );
        assert(response.ok(), await response.text());
        return (await response.json()).task;
      };
      const answer = async () => {
        const question = page.locator(".creation-session-status .user-input-card");
        await question.waitFor();
        await question.locator(".user-input-option").first().click();
        await question.locator(".user-input-submit").click();
      };
      const saved = async (id) => {
        let task;
        await waitFor(async () => {
          task = await detail(id);
          return task.state === "succeeded";
        });
        return task;
      };
      app.creationOutput(null);
      await page.goto(app.base + "/create");
      await page.locator('.creation-skill-discovery [data-skill-id="software-prd"]:enabled').click();
      assert(!(await page.locator("#sessionInspector").isVisible()));
      await page.locator("#prompt").fill("Create portable requirements. " + locale);
      const submission = page.waitForResponse(
        (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const first = (await (await submission).json()).task;
      await page.waitForURL("**/creation/" + first.id + "?creationScope=personal");
      await answer();
      const original = await saved(first.id);
      let filename = original.artifact.file.path;
      assert(!relative(app.dir, filename).startsWith(".."));
      assert.equal(original.workspaceDirectory, dirname(filename));
      assert.match(await readFile(filename, "utf8"), /^# /);
      assert(
        app
          .calls()
          .some(
            (call) =>
              call.method === "thread/start" &&
              call.params.cwd === dirname(filename) &&
              call.params.dynamicTools?.some((tool) => tool.name === "panda_documents_create"),
          ),
      );
      if (fileMove)
        app.creationOutput({
          fileDirectory: "docs",
          text: "The same original now belongs in the code docs directory.",
        });
      await page
        .locator("#prompt")
        .fill(
          fileMove
            ? "Move this same Markdown into the code docs directory and continue editing it."
            : "Add acceptance criteria to the same document.",
        );
      const follow = page.waitForResponse(
        (r) => r.url().endsWith("/document-creations/message") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const next = (await (await follow).json()).task;
      await page.waitForURL("**/creation/" + next.id + "?creationScope=personal");
      await answer();
      const updated = await saved(next.id);
      await page.locator(".creation-session-status .user-input-card").waitFor({ state: "hidden" });
      assert.equal(updated.artifact.documentId, original.artifact.documentId);
      if (fileMove) {
        assert.equal(await lstat(filename).catch(() => null), null);
        filename = join(docs, basename(filename));
        assert.equal(updated.workspaceDirectory, original.workspaceDirectory);
        assert.equal((await detail(first.id)).artifact.file.path, filename);
      }
      assert.equal(updated.artifact.file.path, filename);
      // The native fixture emits identical rich source on both rounds, so no redundant saved revision is needed.
      assert.equal(updated.artifact.revision, fileMove ? 2 : 1);
      assert.equal(
        (await readdir(dirname(filename))).filter((name) =>
          fileMove ? name === basename(filename) : name.endsWith(".md"),
        ).length,
        1,
      );
      await page.locator("#prompt").fill("Keep this unsent draft during locale changes and reload.");
      if (width < 1081) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionInspector").waitFor({ state: "visible" });
      await waitFor(async () => (await page.locator("#sessionDomainSections").textContent()).includes(filename));
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await waitFor(async () => (await page.locator("#sessionDomainSections").textContent()).includes(filename));
      const location = page.locator(".creation-file-location");
      assert(!(await location.evaluate((node) => node.open)));
      await location.locator("summary").scrollIntoViewIfNeeded();
      if (width >= 1081) {
        await location.locator("summary").focus();
        await page.keyboard.press("Enter");
      } else await location.locator("summary").click();
      assert(await location.evaluate((node) => node.open));
      const geometry = await page
        .locator("#sessionDomainSections .session-caption")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.textContent.includes(".md"))
            .map((node) => ({ width: node.clientWidth, scrollWidth: node.scrollWidth })),
        );
      assert(geometry.length > 0 && geometry.every((row) => row.scrollWidth <= row.width + 1));
      if (fileMove) await location.locator("p").scrollIntoViewIfNeeded();
      else await location.locator("summary").click();
      await page.locator("#sessionDomainSections [data-activity-status]").waitFor({ state: "hidden" });
      await location.locator("summary").scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${out}/saved-${locale}-${width}.png` });
      if (width < 1081) await page.locator('#sessionInspector [data-session-action="close"]').click();
      assert.match(await page.locator("#prompt").inputValue(), /Keep this unsent draft/);
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#prompt")?.value.includes("Keep this unsent draft"));
      assert.equal((await detail(next.id)).artifact.file.path, filename);
      assert.deepEqual(errors, []);
      results.push({
        locale,
        width,
        sameDocument: true,
        stableFilename: true,
        persistentEngineDirectory: true,
        portableFile: true,
        requestedCodeDirectory: fileMove,
        fileDisclosureKeyboardAndTouch: true,
        localeSwitchAndReloadDraftRetained: true,
        geometry,
        errors,
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
