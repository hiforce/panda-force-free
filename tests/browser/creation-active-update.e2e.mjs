import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_CREATION_ACTIVE_PROOF || ".artifacts/creation-active-update";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  startupTimeoutMs: 60000,
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
});
const prefix = "/api/personal/document-creations";
const records = [];
try {
  for (const [engine, width, locale, supplementLabel] of [
    [chromium, 1440, "en", "Update this task"],
    [chromium, 1440, "zh-CN", "补充当前任务"],
    [webkit, 390, "zh-HK", "補充目前任務"],
    [webkit, 320, "zh-TW", "補充目前任務"],
  ]) {
    const browser = await engine.launch();
    const context = await browser.newContext({
      viewport: { width, height: 920 },
      locale,
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    try {
      await context.addInitScript((value) => {
        if (window === window.top && /^https?:$/.test(location.protocol))
          localStorage.setItem("panda-force-locale", value);
      }, locale);
      await app.signIn(context);
      const page = await context.newPage();
      page.setDefaultTimeout(25000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const post = (suffix) =>
        page.waitForResponse(
          (response) => response.url().endsWith(prefix + suffix) && response.request().method() === "POST",
        );
      const read = async (id) =>
        (await (await context.request.get(app.base + prefix + "/detail?id=" + id)).json()).task;

      await page.goto(app.base + "/create");
      const composer = page.locator("#composer");
      const prompt = page.locator("#prompt");
      const chips = composer.locator("[data-selected-skill]");
      await page.locator('.creation-discovery-add[data-skill-id="software-prd"]').click();
      await chips.waitFor();
      await prompt.fill("Write an editable requirements document.");
      const initial = post("");
      await page.locator("#sendButton").click();
      const response = await initial;
      assert.equal(response.status(), 202, await response.text());
      assert.equal(response.request().postDataJSON().selections[0].id, "software-prd");
      const { task } = await response.json();
      const target = "/creation/" + task.id + "?creationScope=personal";
      await page.waitForURL("**" + target);
      const question = page.locator(".creation-session-status .user-input-card");
      await question.waitFor();
      await chips.waitFor({ state: "detached" });
      assert.equal(await prompt.inputValue(), "");
      assert.equal((await read(task.id)).selections[0].id, "software-prd");

      await page.goto(app.base + "/create");
      await prompt.waitFor();
      assert.equal(await chips.count(), 0);
      assert.equal(await prompt.inputValue(), "");
      await page.goto(app.base + target);
      await question.waitFor();
      assert.equal(await chips.count(), 0);
      const details = page.locator(".creation-session-status [data-creation-progress] details");
      await details.locator("time").first().waitFor();
      const progress = page
        .locator(".turn-event-stream")
        .getByText("I am reviewing the requirements", { exact: false });
      await progress.waitFor();
      const supplement = page.getByRole("button", { name: supplementLabel, exact: true }).first();
      const disclosure = composer.locator(".message-composer-disclosure");
      await disclosure.click();
      await prompt.waitFor({ state: "hidden" });
      await supplement.click();
      await prompt.waitFor();
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
      assert.equal(await prompt.evaluate((field) => field === document.activeElement), true);
      const starts = () => app.calls().filter((call) => call.method === "turn/start").length;
      const baseline = starts();
      const update = "Include a glossary with concrete examples.";
      await prompt.fill(update);
      assert.equal(await page.locator("#sendButton").getAttribute("aria-label"), supplementLabel);
      await page.screenshot({ path: join(out, `running-${locale}-${width}.png`) });
      const submitted = post("/message");
      await page.locator("#sendButton").click();
      const receipt = await submitted;
      assert.equal(receipt.status(), 202, await receipt.text());
      assert.equal((await receipt.json()).task.id, task.id);
      const sent = receipt.request().postDataJSON();
      assert.equal(sent.updateGeneration, (await read(task.id)).generation);
      assert.equal(sent.selections, undefined);
      await page.locator(".turn-event-stream").getByText(update, { exact: true }).waitFor();
      assert.equal(starts(), baseline);
      assert.equal(await prompt.inputValue(), "");
      assert.equal(await chips.count(), 0);

      const late = "Add a short conclusion as well.";
      await prompt.fill(late);
      await question.locator(".user-input-option").first().click();
      await question.locator(".user-input-submit").click();
      await waitFor(async () => (await read(task.id))?.state === "succeeded", 25000);
      const notice = page.locator(".creation-update-notice");
      await notice.waitFor();
      assert.equal(await prompt.inputValue(), late);
      await page.reload();
      await notice.waitFor();
      assert.equal(await prompt.inputValue(), late);
      assert.equal(starts(), baseline);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `closed-${locale}-${width}.png`) });
      await notice.getByRole("button").click();
      await notice.waitFor({ state: "hidden" });
      assert.equal(await prompt.inputValue(), late);
      assert.equal(starts(), baseline);
      const legacySelection = response.request().postDataJSON().selections;
      await page.evaluate((skills) => {
        const key = "panda-force-composer-drafts";
        const drafts = JSON.parse(localStorage.getItem(key) || "{}");
        drafts["creation:personal:new"] = { text: "", mentions: [], attachments: [], skills };
        localStorage.setItem(key, JSON.stringify(drafts));
      }, legacySelection);
      await page.goto(app.base + "/create");
      await prompt.waitFor();
      assert.equal(await chips.count(), 0);
      await page.locator('.creation-discovery-add[data-skill-id="software-prd"]').click();
      await chips.waitFor();
      await page.reload();
      await chips.waitFor();
      if (locale === "zh-TW") {
        app.creationOutput({ projectId: "missing-project-fixture" });
        const firstBrief = "Create a document with a concrete glossary.";
        await prompt.fill(firstBrief);
        const initialFailure = post("");
        await page.locator("#sendButton").click();
        const { task: failed } = await (await initialFailure).json();
        await page.waitForURL("**/creation/" + failed.id + "?creationScope=personal");
        await question.locator(".user-input-option").first().click();
        await question.locator(".user-input-submit").click();
        await waitFor(async () => (await read(failed.id))?.state === "failed", 25000);
        await page.getByText("未儲存成品。你可以在下方補充需求，或重試任務。").waitFor();
        app.creationOutput(null);
        await prompt.fill("繼續儲存");
        await page.screenshot({ path: join(out, `failed-ready-${locale}-${width}.png`) });
        const resumed = post("/message");
        await page.locator("#sendButton").click();
        const delivery = await resumed;
        assert.equal(delivery.status(), 202, await delivery.text());
        const { task: next } = await delivery.json();
        assert.notEqual(next.id, failed.id);
        await page.waitForURL("**/creation/" + next.id + "?creationScope=personal");
        await question.waitFor();
        assert(
          app
            .calls()
            .filter((call) => call.method === "turn/start")
            .at(-1)
            .params.input[0].text.includes(firstBrief),
        );
        assert.equal(await prompt.inputValue(), "");
        await page.screenshot({ path: join(out, `failure-follow-up-${locale}-${width}.png`) });
      }
      assert.deepEqual(errors, []);
      records.push({
        locale,
        width,
        clearedBothDrafts: true,
        originalSelectionPreserved: true,
        sameTask: true,
        lateDraftPreserved: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(join(out, "results.json"), JSON.stringify(records, null, 2) + "\n");
} finally {
  await app.dispose();
}
