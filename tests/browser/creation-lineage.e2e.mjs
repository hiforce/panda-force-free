import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { seedCreationRounds } from "../support/creation-rounds.js";
const out = process.env.PANDA_CREATION_LINEAGE_PROOF || ".artifacts/creation-lineage-browser";
await mkdir(out, { recursive: true });
const image = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#168c9b" } })
  .png()
  .toBuffer();
const app = await createAppFixture({
  applicationCreation: true,
  applicationImage: image.toString("base64"),
  models: [
    {
      id: "gpt-fixture",
      model: "gpt-fixture",
      isDefault: true,
      displayName: "Fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
});
let initial, latest, historyIds;
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (location.protocol.startsWith("http")) localStorage.setItem("panda-force-locale", locale);
      }, locale);
      const prefix = "/api/personal/document-creations",
        api = async (path, data) => {
          const response = await context.request.fetch(app.base + prefix + path, {
            method: data ? "POST" : "GET",
            headers: { Origin: app.base },
            ...(data ? { data } : {}),
          });
          assert(response.ok(), await response.text());
          return response.json();
        };
      const complete = async (id) =>
        waitFor(async () => {
          const task = (await api("/detail?id=" + id)).task;
          if (task.question)
            await api("/answer", {
              id: task.question.id,
              answers: Object.fromEntries(
                task.question.questions.map((q) => [q.id, { answers: [q.options?.[0]?.label || "General readers"] }]),
              ),
            });
          if (task.failure) throw Error(JSON.stringify(task.failure));
          return task.state === "succeeded" ? task : null;
        }, 60000);
      if (!initial) {
        const options = await api("/options");
        initial = (
          await api("", {
            id: randomUUID(),
            projectId: "personal",
            treeVersion: 0,
            parentId: null,
            locale: "en",
            prompt: "Create a Greek history illustration",
            profileId: options.defaultProfileId,
            selections: [],
            outputType: "image",
          })
        ).task;
        initial = await complete(initial.id);
        historyIds = await seedCreationRounds(app.dir, initial.id, 24);
        latest = (
          await api("/message", {
            id: randomUUID(),
            taskId: initial.id,
            prompt: "Please update the illustration into a comic",
            outputType: "image",
          })
        ).task;
        latest = await complete(latest.id);
      }
      const list = await api("?project=*");
      assert.equal(list.tasks.length, 1);
      assert.equal(list.tasks[0].creation.id, initial.id);
      assert.equal(list.tasks[0].creation.rounds, 26);
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.setDefaultTimeout(35000);
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));
      await page.goto(app.base + "/create?view=works");
      const activity = page.locator("[data-activity-list]");
      await activity.locator("[data-activity-task]").waitFor();
      assert.equal(await activity.locator("[data-activity-task]").count(), 1);
      assert((await activity.innerText()).includes(initial.prompt));
      assert((await activity.innerText()).includes("26"));
      await page.screenshot({ path: `${out}/activity-${locale}-${width}.png` });
      // An old bookmark resolves the whole creation and writes subsequent updates to its latest round.
      await page.goto(app.base + "/creation/" + initial.id + "?creationScope=personal");
      await page.locator('.creation-task[data-creation-task="' + latest.id + '"]').waitFor();
      await page.locator("#prompt").fill("Keep this unsent continuation");
      const earlier = page.locator("[data-creation-earlier]");
      await earlier.waitFor();
      let failed = false;
      await page.route("**/document-creations/rounds?*cursor=*", (route) => {
        if (!failed) {
          failed = true;
          return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
        }
        return route.continue();
      });
      await earlier.click();
      await waitFor(() => earlier.isEnabled());
      await earlier.click();
      await waitFor(() =>
        page
          .locator('#conversation [data-item-id$="-request"]')
          .count()
          .then((n) => n >= 20),
      );
      while (await earlier.isVisible()) {
        await earlier.click();
        await waitFor(() => earlier.isEnabled());
      }
      for (const id of historyIds)
        assert.equal(await page.locator('[data-item-id="creation-' + id + '-request"]').count(), 1);
      assert.equal(await page.locator('#conversation [data-item-id$="-request"]').count(), 26);
      assert((await page.locator("#conversation").innerText()).includes("Historical answer 1"));
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent continuation");
      for (const next of [locale === "en" ? "zh-CN" : "en", locale]) {
        await page.locator(`[data-chrome-menu="${width < 768 ? "preferences" : "language"}"]`).click();
        if (width < 768) await page.locator('[data-chrome-action="menu"][data-value="language"]').click();
        await page.locator(`[data-chrome-action="locale"][data-value="${next}"]`).click();
        await page.waitForFunction((locale) => document.documentElement.lang === locale, next);
      }
      assert.equal(await page.locator('#conversation [data-item-id$="-request"]').count(), 26);
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent continuation");
      assert.equal(await page.locator(".creation-session-notice").textContent(), "");
      await page.locator('[data-item-id="creation-' + initial.id + '-request"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/history-${locale}-${width}.png` });
      await page.reload();
      await page.locator('.creation-task[data-creation-task="' + latest.id + '"]').waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent continuation");
      const originalVersion = page.locator('[data-creation-round="' + initial.id + '"]');
      if (!(await originalVersion.isVisible())) await page.locator("#sessionInfoButton").click();
      await originalVersion.click();
      const dialog = page.locator(".creative-asset-dialog[open]");
      await waitFor(() =>
        dialog.locator("img[data-asset-native]").evaluate((img) => img.complete && img.naturalWidth === 1000),
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (width < 768) await page.locator('#sessionInspector [data-session-action="close"]').click();
      if (locale === "zh-TW") {
        const submitted = page.waitForResponse(
          (r) => r.url().endsWith(prefix + "/message") && r.request().method() === "POST",
        );
        await page.locator("#sendButton").click();
        const response = await submitted;
        assert.equal(response.request().postDataJSON().taskId, latest.id);
        const next = await complete((await response.json()).task.id);
        assert.equal(next.previousTaskId, latest.id);
        const grouped = await api("?project=*");
        assert.equal(grouped.tasks.length, 1);
        assert.equal(grouped.tasks[0].creation.rounds, 27);
      }
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      records.push({
        locale,
        width,
        groupedNativeImages: true,
        legacyRounds: true,
        rounds: 26,
        oldBookmarkLatest: true,
        allConversationLoaded: true,
        retry: true,
        draftAndLanguagePreserved: true,
        reload: true,
        errors: 0,
      });
      console.log("Creation lineage verified", locale, width);
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    out + "/checks.json",
    JSON.stringify(
      {
        passed: true,
        records,
        inference:
          "Controlled CLI fixture; synthetic historical metadata is explicitly scoped to the disposable fixture",
      },
      null,
      2,
    ),
  );
} finally {
  await app.dispose();
}
