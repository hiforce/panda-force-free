import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { legacyMemoryPath } from "../../src/shared/project-memory/contracts.ts";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_SESSION_MEMORY_PROOF || ".artifacts/session-memory-inspector";
await mkdir(proof, { recursive: true });
const app = await createAppFixture({
  nativeInputHistory: true,
  applicationMemory: true,
  completedTurnNotifications: true,
  startupTimeoutMs: 60000,
});
const harness = "/api/personal/harness/conversations";
const legacy = legacyMemoryPath + "old-alpha";
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "en"],
    [chromium, 1440, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const mobile = width < 768;
      const context = await browser.newContext({
        viewport: { width, height: 880 },
        locale,
        isMobile: mobile,
        hasTouch: mobile,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "aurora");
      }, locale);
      const request = (path, method = "GET", data) =>
        context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
      const api = async (path, method, data) => {
        const response = await request(path, method, data);
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      if (locale === "zh-CN") {
        let { revision } = await api("/api/projects");
        const first = await api("/api/projects", "POST", {
          name: "Atlas Web",
          code: "atlas",
          revision,
          operationId: crypto.randomUUID(),
        });
        const atlas = first.projects.find((item) => item.code === "atlas");
        const second = await api("/api/projects", "POST", {
          name: "Other Project",
          code: "other-project",
          revision: first.revision,
          operationId: crypto.randomUUID(),
        });
        assert.equal((await request(legacy)).status(), 404);
        await api("/api/projects/assign", "POST", {
          projectId: atlas.id,
          sessionIds: ["old-alpha"],
          revision: second.revision,
        });
        assert.equal((await request(legacyMemoryPath + "old-beta")).status(), 404);
        assert.equal((await fetch(app.base + legacy)).status, 401);
      }
      const projects = (await api("/api/projects")).projects;
      const atlas = projects.find((item) => item.code === "atlas");
      const other = projects.find((item) => item.code === "other-project");
      const before = (await api(legacy)).entries.length;
      const page = await context.newPage();
      page.setDefaultTimeout(25000);
      await page.goto(app.base + "/task/old-alpha");
      await page.locator("#prompt").waitFor({ state: "visible" });
      if (locale === "zh-CN") {
        await page.locator("#prompt").fill("Project convention: check window = four business days");
        await page.locator("#sendButton").click();
        await waitFor(async () => (await api(legacy + "?preview=true")).candidates.length > 0, 20000);
        assert.deepEqual((await api(legacy)).entries, []);
      }
      const title = await page.locator("#workspaceContextHeader .thread-heading").innerText();
      const open = page.locator("#sessionInfoButton:visible, #sessionMobileSummary [data-session-action=open]:visible");
      await open.first().click();
      const card = page.locator("#sessionMemoryControl");
      const summary = card.locator("[data-memory-manual-count]");
      await summary.waitFor({ state: "visible" });
      assert((await summary.innerText()).includes(String(before)));
      assert.equal(await card.locator("a").count(), 0);
      assert.equal(await card.locator("[data-memory-control-settings]:visible").count(), Number(before > 0));
      const enable = card.locator("[data-memory-control-main]");
      assert(await enable.isVisible());
      if (locale === "zh-CN") assert.equal(await enable.getAttribute("aria-label"), "启用记忆");
      const manual = card.locator("[data-session-action='memory-legacy-save']");
      assert(await manual.isVisible());
      if (mobile) {
        const box = await manual.boundingBox();
        assert(box.width >= 44 && box.height >= 44);
      }
      await card.screenshot({ path: join(proof, "legacy-" + locale + "-" + width + ".png") });
      await manual.click();
      const popup = page.locator("#sessionMemoryDialog");
      const save = popup.locator('button[type="submit"]');
      const value = "legacy verified " + locale;
      if (locale === "zh-CN") {
        const candidate = popup.getByRole("checkbox").first();
        await candidate.waitFor();
        assert(await save.isDisabled());
        assert(!(await candidate.isChecked()));
        await candidate.check();
      } else {
        await popup.locator("summary").evaluate((summary) => {
          summary.parentElement.open = true;
        });
        await popup.locator('[name="key"]').fill("retention " + locale);
        await popup.locator('[name="value"]').fill(value);
      }
      const posted = page.waitForResponse(
        (response) => new URL(response.url()).pathname === legacy && response.request().method() === "POST",
      );
      await save.click();
      const receipt = await posted;
      assert(receipt.ok(), "Legacy convention save failed: " + receipt.status() + " " + (await receipt.text()));
      const expected = locale === "zh-CN" ? "four business days" : value;
      assert(
        (await receipt.json()).entries.some(({ value }) => value === expected),
        "Should return the successfully saved record",
      );
      await popup.getByText(expected, { exact: true }).waitFor();
      assert.equal(await popup.locator("a").count(), 0);
      await popup.locator("[data-close-memory]").click();
      await page.waitForFunction(
        ({ before }) => document.querySelector("[data-memory-manual-count]").textContent.includes(String(before + 1)),
        { before },
      );
      const current = await api(legacy);
      assert.equal(current.entries.length, before + 1);
      assert.equal(
        (await api(legacy, "POST", { entries: [current.entries.find(({ value }) => value === expected)] })).entries
          .length,
        before + 1,
      );
      assert.equal((await request(legacy, "POST", { entries: [{ key: "api key", value: "test" }] })).status(), 400);
      assert.equal((await api("/api/projects/" + other.id + "/memory")).entries.length, 0);
      await card.locator("[data-session-action='memory-legacy-details']").click();
      const text = popup.getByText(expected, { exact: true });
      await text.waitFor();
      await popup.locator("[data-close-memory]").click();
      assert.equal(await page.locator("#workspaceContextHeader .thread-heading").innerText(), title);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (locale === "zh-CN") {
        const p = "/api/projects/" + atlas.id;
        await api(p + "/memory-policy", "PATCH", {
          revision: 0,
          write: true,
          recall: true,
          model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
        });
        await waitFor(async () => (await api(p + "/memory")).index.state === "ready");
        const enabled = page.waitForResponse(
          (res) => new URL(res.url()).pathname === legacy && res.request().method() === "PATCH",
        );
        await enable.click();
        assert.equal((await enabled).status(), 200);
        assert.equal((await api(legacy)).automatic.enabled, true);
        assert.equal((await api(legacy)).automatic.contributed, 0);
        const sendNative = async (text) => {
          await page.locator("#prompt").fill(text);
          await page.locator("#sendButton").click();
          await waitFor(() =>
            app
              .calls()
              .some(
                ({ method, params }) =>
                  method === "turn/start" &&
                  params.threadId === "old-alpha" &&
                  JSON.stringify(params.input).includes(text),
              ),
          );
        };
        await sendNative("Our confirmed cache duration is twenty-four hours.");
        await waitFor(async () => (await api(legacy)).automatic.contributed === 1, 25000);
        const memoryEntry = (await api(p + "/memory")).entries.find(({ key }) => key === "cache-duration");
        assert(memoryEntry);
        const entrySource = memoryEntry.sources[0];
        const location = await api(
          p +
            "/memory-source?" +
            new URLSearchParams({
              conversation: entrySource.conversationId,
              message: entrySource.messageId,
              view: "location",
            }),
        );
        assert.equal(location.message.text, "Our confirmed cache duration is twenty-four hours.");
        assert.equal(location.nativeConversationId, "old-alpha");
        const sourcePage = await context.newPage();
        try {
          const path = "/task/" + encodeURIComponent("harness:" + entrySource.conversationId);
          const query = new URLSearchParams({ project: atlas.id, memoryMessage: entrySource.messageId });
          await sourcePage.goto(app.base + path + "?" + query);
          const openConversation = sourcePage.locator("[data-memory-source-open]:visible");
          await openConversation.waitFor();
          assert.equal(await openConversation.getAttribute("href"), "/task/old-alpha");
        } finally {
          await sourcePage.close();
        }
        await page.screenshot({ path: join(proof, "native-enabled-" + locale + "-" + width + ".png") });
        await enable.click();
        await waitFor(async () => (await api(legacy)).automatic.paused);
        await sendNative("This complete remark occurred in the paused interval.");
        await enable.click();
        await waitFor(async () => !(await api(legacy)).automatic.paused);

        const { conversation } = await api(harness, "POST", { runtimeId: "codex", projectId: atlas.id });
        const dest = harness + "/" + conversation.id;
        const { runId } = await api(dest + "/runs", "POST", {
          requestId: crypto.randomUUID(),
          text: "What is the check window?",
        });
        await waitFor(async () => (await api(dest)).run?.status === "complete");
        const { recalls } = await api(dest + "/memory");
        assert(
          recalls.find((receipt) => receipt.runId === runId && receipt.status === "sent")?.references[0]?.manual
            ?.length,
        );
        assert.equal((await api(dest + "/memory-summary")).recalled, 1);
        assert(
          app
            .calls()
            .some(
              (call) =>
                call.method === "turn/start" && JSON.stringify(call.params.input).includes("four business days"),
            ),
        );
        await page.goto(app.base + "/task/harness:" + conversation.id);
        await open.first().click();
        await card.locator("[data-memory-control-counts]:visible").waitFor();
        assert.equal(await card.locator("[data-memory-recalled]").innerText(), "1");
        assert(await card.locator("[data-memory-control-settings]").isVisible());
        const primaryBox = await card.locator("[data-memory-control-main]").boundingBox();
        const pauseBox = await card.locator("[data-memory-control-button]").boundingBox();
        assert(Math.abs(primaryBox.y - pauseBox.y) <= 1, "Desktop session actions should share one row");

        await card.screenshot({ path: join(proof, "managed-" + locale + "-" + width + ".png") });
        if (await card.locator("[data-session-action=memory-history]").isVisible())
          await card.locator("[data-session-action=memory-history]").click();
        else {
          await card.locator("[data-session-action=memory-details]").click();
          await popup.locator("[data-memory-backfill] summary").click();
        }
        await popup.locator("[data-memory-backfill][open]").waitFor();
        await popup.locator('[data-memory-backfill] select[name="days"]').waitFor();
        assert.equal(await popup.locator("[data-session-memory-project]").count(), 0);
        await popup.locator("[data-close-memory]").click();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Session memory inspector, explicit legacy review, idempotency, project isolation and same-project recall passed.",
  );
} finally {
  await app.dispose();
}
