import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_CREATION_DIALOGUE_PROOF || ".artifacts/creation-dialogue/browser";
await mkdir(output, { recursive: true });
const image = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#39698a" } })
  .png()
  .toBuffer();
const app = await createAppFixture({
  applicationCreation: true,
  applicationImage: image.toString("base64"),
  startupTimeoutMs: 90000,
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
const prefix = "/api/personal/document-creations";
try {
  for (const [engine, width, locale, status] of [
    [chromium, 1440, "en", "Answered"],
    [chromium, 1440, "zh-CN", "已回复"],
    [webkit, 390, "zh-HK", "已回覆"],
    [webkit, 390, "zh-TW", "已回覆"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 930 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript((value) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", value);
      }, locale);
      await app.signIn(context);
      const api = async (path, data) => {
        const response = await context.request.fetch(app.base + prefix + path, {
          method: data ? "POST" : "GET",
          data,
          headers: { Origin: app.base },
        });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const options = await api("/options"),
        id = crypto.randomUUID();
      await api("", {
        id,
        projectId: "personal",
        parentId: null,
        treeVersion: 0,
        locale,
        selections: [],
        profileId: options.defaultProfileId,
        outputType: "image",
        dialogue: true,
        prompt: "Create a fixture illustration",
      });
      const original = await waitFor(async () => {
        const { task } = await api("/detail?id=" + id);
        if (task.failure) throw Error(JSON.stringify(task));
        return task.state === "succeeded" ? task : null;
      }, 45000);
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
      await page.locator('[data-creation-task="' + id + '"]').waitFor();
      await page.locator("#prompt").fill("Why did the fixture use that classification?");
      const sent = page.waitForResponse(
        (r) => r.url().endsWith(prefix + "/message") && r.request().method() === "POST",
      );
      await page.locator("#sendButton").click();
      const response = await sent;
      assert.equal(response.status(), 202, await response.text());
      const { task: reply } = await response.json();
      const answer = page
        .locator("#conversation")
        .getByText("The original was based on the first brief.", { exact: true });
      await answer.waitFor({ timeout: 16000 }).catch(async (error) => {
        const { task } = await api("/detail?id=" + reply.id);
        throw new Error(`${locale} answer missing: ${task.state} ${JSON.stringify(task.progress)}`, { cause: error });
      });
      await page.locator(".creation-session-status").waitFor({ state: "hidden" });
      if (width < 768) await page.locator("#sessionMobileStatus").filter({ hasText: status }).waitFor();
      const detail = (await api("/detail?id=" + reply.id)).task;
      assert.equal(detail.state, "replied");
      assert.equal(detail.artifact, null);
      assert(!detail.progress.some((item) => item.stage === "saving" || item.operation === "panda_images_render"));
      assert.deepEqual((await api("/detail?id=" + id)).task.artifact, original.artifact);
      await page.locator("[data-creation-open]").waitFor();
      await page.reload();
      await answer.waitFor();
      await page.locator("[data-creation-open]").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(output, locale + "-" + width + ".png") });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
