import { appendFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { parseRollout } from "../../src/server/conversation/live-session.js";
const fixture = await createAppFixture({ questionnaireRollout: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en",
    isMobile: true,
    hasTouch: true,
  });
  await fixture.signIn(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
  const rollout = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "questions" } },
    {
      type: "response_item",
      payload: {
        id: "async-question-1",
        type: "function_call",
        name: "request_user_input_async",
        call_id: "question-call",
        arguments: JSON.stringify({
          questions: [
            { title: "Which repository?", options: ["Public free repository", "Private source repository"] },
            { title: "What should change?" },
          ],
        }),
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const item = parseRollout(rollout).turn.items[0];
  assert.ok(item, "Host rollout must retain the questionnaire before the browser receives it");
  const card = page.locator("[data-async-question-card]");
  await card.waitFor();
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await card.waitFor();
  await page.waitForFunction(() => document.querySelector("#sessionMobileStatus").textContent === "Your input needed");
  await page.locator("#sessionInfoButton").tap();
  await page.locator("#sessionPendingAction").tap();
  await page.locator("#sessionInspector").waitFor({ state: "hidden" });
  assert.equal(await card.evaluate((element) => element.contains(document.activeElement)), true);
  assert.equal(await card.locator("fieldset").count(), 2);
  // A native/rollout alias may arrive after the card, including on reconnect.
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "questions",
      item: {
        id: "host-user-questions-opening",
        type: "userMessage",
        content: [{ type: "text", text: "Show a questionnaire." }],
      },
    }),
  );
  assert.equal(await card.getAttribute("data-status"), "open");
  assert.equal(await card.locator("fieldset").first().isEnabled(), true);
  // Older native items can also be backfilled while a newer question is open.
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.syncTurnSnapshot({
      id: "older-history-turn",
      status: "completed",
      items: [{ id: "older-history-user", type: "userMessage", content: [{ type: "text", text: "Earlier prompt" }] }],
    }),
  );
  assert.equal(await card.getAttribute("data-status"), "open");
  await page.locator("#prompt").fill("Keep my existing draft.");
  await page.locator("#attachmentInput").setInputFiles({
    name: "unsent-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Unsent draft attachment"),
  });
  await page.waitForFunction(() =>
    globalThis.__pandaForceDebug.state.composerAttachments.some(
      (item) => item.status === "ready" && item.name === "unsent-draft.txt",
    ),
  );
  await card.locator(".user-input-option strong").first().tap();
  assert.equal(await card.locator('[type=radio][value="0"]').isChecked(), true);
  await card.locator("textarea:visible").fill("Rename all product variables.");
  const before = fixture.calls().filter((c) => c.method === "turn/start" || c.method === "turn/steer").length;
  assert.equal(fixture.calls().filter((c) => c.method === "turn/start" || c.method === "turn/steer").length, before);
  await card.locator("[type=submit]").tap();
  await page.waitForFunction(() => document.querySelector("[data-async-question-card]").dataset.status === "submitted");
  assert.equal(await page.locator("#prompt").inputValue(), "Keep my existing draft.");
  assert.equal(await card.getAttribute("open"), null);
  const submissions = fixture.calls().filter((c) => c.method === "turn/start" || c.method === "turn/steer");
  assert.equal(submissions.length, before + 1);
  const payload = JSON.stringify(submissions.at(-1).params.input);
  assert.ok(payload.includes("Public free repository"));
  assert.ok(payload.includes("Rename all product variables."));
  assert.ok(!payload.includes("Keep my existing draft."));
  assert.ok(!payload.includes("unsent-draft.txt"));
  assert.equal(
    await page.evaluate(() => globalThis.__pandaForceDebug.state.composerAttachments[0]?.name),
    "unsent-draft.txt",
  );
  assert.equal(await card.locator("[type=submit]").isVisible(), false);
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "reply",
      item: { id: "reply-1", type: "userMessage", content: [{ type: "inputText", text: "Public free repository" }] },
    }),
  );
  assert.equal(await card.getAttribute("data-status"), "submitted");
  assert.equal(await card.getAttribute("open"), null);
  await card.locator("summary").click();
  assert.equal(await card.locator("[type=submit]").isVisible(), false);
  assert.equal(await card.locator("[type=radio]").first().isDisabled(), true);
  await page.evaluate(
    (item) =>
      globalThis.__pandaForceDebug.notify("item/completed", { threadId: "old-alpha", turnId: "questions", item }),
    item,
  );
  assert.equal(await page.locator("[data-async-question-card]").count(), 1);
  assert.equal(await card.getAttribute("data-status"), "submitted");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#prompt").value === "");
  const normal = fixture
    .calls()
    .filter((call) => call.method === "turn/start")
    .at(-1);
  assert.ok(JSON.stringify(normal.params.input).includes("Keep my existing draft."));
  assert.ok(JSON.stringify(normal.params.input).includes("unsent-draft.txt"));
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.composerAttachments.length), 0);
  await page.evaluate(() => {
    const notify = globalThis.__pandaForceDebug.notify;
    notify("turn/started", {
      threadId: "old-alpha",
      turn: { id: "running-question-turn", status: "inProgress", items: [] },
    });
    notify("item/completed", {
      threadId: "old-alpha",
      turnId: "running-question-turn",
      item: {
        id: "async-active",
        type: "dynamicToolCall",
        tool: "request_user_input_async",
        arguments: { questions: [{ title: "Active question", options: ["Proceed"] }] },
      },
    });
  });
  const activeCard = page.locator('[data-async-question-card][data-item-id="async-active"]');
  await activeCard.locator('[type=radio][value="0"]').check();
  const activeBefore = fixture.calls().filter((call) => call.method === "turn/steer").length;
  await activeCard.locator("[type=submit]").evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-item-id="async-active"]').dataset.status === "submitted",
  );
  assert.equal(fixture.calls().filter((call) => call.method === "turn/steer").length, activeBefore + 1);
  const activeReply = fixture
    .calls()
    .filter((call) => call.method === "turn/steer")
    .at(-1);
  assert.equal(activeReply.params.expectedTurnId, "running-question-turn");
  assert.ok(JSON.stringify(activeReply.params.input).includes("Proceed"));
  // Native history must remember that a later user reply retired the question.
  appendFileSync(
    join(fixture.dir, "sessions", "questionnaire.jsonl"),
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "after-answer" } },
      { type: "event_msg", payload: { type: "user_message", message: "Which repository?\nPublic free repository" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "after-answer" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await card.waitFor();
  assert.equal(await card.getAttribute("data-status"), "earlier");
  assert.equal(await card.getAttribute("open"), null);
  assert.equal(await card.locator("[type=submit]").isVisible(), false);
  await page.evaluate(async () => {
    const api = globalThis.__pandaForceDebug;
    await api.openThread("old-beta");
    await api.openThread("old-alpha");
  });
  assert.equal(await card.getAttribute("data-status"), "earlier");
  assert.equal(await card.getAttribute("open"), null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      interactiveOptionsAndText: true,
      draftPreserved: true,
      singleClickSubmission: true,
      doubleClickDoesNotDuplicate: true,
      draftAttachmentPreserved: true,
      normalComposerSend: true,
      activeTurnAnswerSteers: true,
      replyCollapsesHistory: true,
      noReplayReopening: true,
      mobile: true,
      errors,
    }),
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
