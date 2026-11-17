import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = ".artifacts/creation-document-revisions";
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
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [chromium, 1600, "zh-CN"],
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
      const api = async (path, method = "GET", data) => {
        const response = await context.request.fetch(app.base + path, {
          method,
          headers: { Origin: app.base },
          ...(data ? { data } : {}),
        });
        assert(response.ok(), await response.text());
        return response.json();
      };
      const detail = async (id) =>
        (await api("/api/personal/document-creations/detail?" + new URLSearchParams({ id }))).task;
      const answer = async () => {
        const question = page.locator(".creation-session-status .user-input-card");
        await question.waitFor();
        await question.locator(".user-input-option").first().click();
        await question.locator(".user-input-submit").click();
      };
      await page.goto(app.base + "/create");
      const gallery = page.locator(".creation-skill-discovery");
      await gallery.locator('[data-skill-id="software-prd"]:enabled').waitFor();
      assert(!(await page.locator("#sessionInspector").isVisible()));
      await gallery.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".creation-discovery-cover img")].filter(
            (img) => img.complete && img.naturalWidth > 0,
          ).length >= 6,
      );
      await gallery.locator(".creation-discovery-cover img").evaluateAll(async (images) => {
        for (const image of images) image.loading = "eager";
        await Promise.all(images.map((image) => image.decode()));
      });
      await page.screenshot({ path: `${out}/gallery-${locale}-${width}.png` });
      const cards = await gallery.locator(".creation-discovery-card").evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
      );
      assert(cards.every((card) => card.width < 300 && card.height < 340));
      await gallery.locator('[data-skill-id="software-prd"]').click();
      assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 1);
      await page.locator("#prompt").fill("Write the product requirements. " + locale);
      const sent = page.waitForResponse(
        (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const first = (await (await sent).json()).task;
      await page.waitForURL("**/creation/" + first.id + "?creationScope=personal");
      await answer();
      let original;
      await waitFor(async () => {
        original = await detail(first.id);
        return original.state === "succeeded";
      });
      const documentId = original.artifact.documentId;
      await page.locator("#prompt").fill("Add acceptance criteria to this document.");
      const follow = page.waitForResponse(
        (r) => r.url().endsWith("/document-creations/message") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const second = (await (await follow).json()).task;
      assert.equal(second.document.documentId, documentId);
      await page.waitForURL("**/creation/" + second.id + "?creationScope=personal");
      await page.locator(".creation-session-status .user-input-card").waitFor();
      const scope = new URLSearchParams({ project: "personal", id: documentId }),
        path = "/api/personal/project-documents/";
      const opened = await api(path + "editor?" + scope),
        draft = await api(path + "editor?" + scope, "PUT", {
          operationId: crypto.randomUUID(),
          version: opened.draft.version,
          baseRevisionId: opened.saved.revision.id,
          working: {
            ...opened.working,
            title: "Manually refined requirements",
            body: {
              ...opened.working.body,
              document: {
                ...opened.working.body.document,
                content: [
                  ...opened.working.body.document.content,
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Manual corrections saved during generation." }],
                  },
                ],
              },
            },
          },
        });
      await api(path + "checkpoints?" + scope, "POST", {
        operationId: crypto.randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.receipt.version,
      });
      await page.locator("#prompt").fill("Keep this draft while recovering.");
      await answer();
      await page.locator('.creation-session-status [data-creation-action="retry"]').waitFor();
      assert.equal((await detail(second.id)).failure, "targetChanged");
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale === "en" ? "zh-CN" : "en"),
        locale,
      );
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      assert.match(await page.locator("#prompt").inputValue(), /Keep this draft/);
      await page.locator(".creation-session-status").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/source-${locale}-${width}.png` });
      if (width < 1081) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionInspector").waitFor({ state: "visible" });
      await page.screenshot({ path: `${out}/conflict-${locale}-${width}.png` });
      if (width < 1081) await page.locator('#sessionInspector [data-session-action="close"]').click();
      const retryResponse = page.waitForResponse(
        (r) => r.url().endsWith("/document-creations/retry") && r.request().method() === "POST",
      );
      await page.locator('.creation-session-status [data-creation-action="retry"]').click();
      const recovered = (await (await retryResponse).json()).task;
      await page.waitForURL("**/creation/" + recovered.id + "?creationScope=personal");
      assert.match(await page.locator("#prompt").inputValue(), /Keep this draft/);
      await answer();
      let saved;
      await waitFor(async () => {
        saved = await detail(recovered.id);
        return saved.state === "succeeded";
      });
      assert.equal(saved.artifact.documentId, documentId);
      assert.equal(saved.artifact.revision, 3);
      assert.equal(saved.artifact.title, "Manually refined requirements");
      if (width < 1081) await page.locator("#sessionInfoButton").click();
      await page.locator("#sessionInspector").waitFor({ state: "visible" });
      assert.match(await page.locator("#sessionDomainSections").textContent(), /Manually refined requirements/);
      await page.screenshot({ path: `${out}/saved-${locale}-${width}.png` });
      const history = await api(path + "revisions?" + scope);
      assert.equal(history.revisions.length, 3);
      assert.equal((await api(path + "editor?" + scope)).saved.document.revision, 3);
      if (width < 1081) await page.locator('#sessionInspector [data-session-action="close"]').click();
      await page.goto(app.base + "/create");
      await waitFor(async () => (await page.locator(`[data-activity-task="${recovered.id}"]`).count()) === 1);
      assert.equal(
        await page.locator(`[data-activity-task="${first.id}"],[data-activity-task="${second.id}"]`).count(),
        0,
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      results.push({ locale, width, documentIdRetained: true, savedRevisions: 3, draftRetained: true, cards, errors });
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        await page.screenshot({ path: `${out}/failed-${locale}-${width}.png` });
        console.error({
          locale,
          width,
          url: page.url(),
          text: (await page.locator("#composer").textContent())?.slice(0, 400),
        });
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
