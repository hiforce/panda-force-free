import assert from "node:assert/strict";
import { createConversationHistory } from "../../src/server/conversation/history.js";

// Use the real history polling path while the browser is tapping and submitting.
export async function checkInteractiveHistory(page, context, browserName) {
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.__pandaForceDebug?.state.connected);
  const thread = {
    id: "interactive-history",
    turns: [
      {
        id: "interactive-turn",
        status: "inProgress",
        items: [
          {
            id: "interactive-question",
            type: "agentMessage",
            delivery: "async",
            questions: [
              { title: "How did you reach the bottom?", options: ["Finger swipe", "Arrow button"] },
              { title: "Describe the result" },
            ],
          },
        ],
      },
    ],
  };
  const history = createConversationHistory({ readThread: async () => thread, fingerprint: () => 1 });
  const snapshot = await history.read({ threadId: thread.id });
  await page.evaluate((snapshot) => {
    const api = window.__pandaForceDebug;
    api.state.ws.onmessage = null;
    api.state.events?.close();
    api.mutations.set("transport", "sse");
    api.startNewTask();
    window.interactionCalls = [];
    window.interactionSnapshot = snapshot;
    window.interactionRefresh = false;
    window.interactionReads = 0;
    window.answerCalls = 0;
    const original = window.fetch;
    window.fetch = async (resource, options = {}) => {
      if (new URL(typeof resource === "string" ? resource : resource.url, location.href).pathname !== "/api/rpc")
        return original(resource, options);
      const call = JSON.parse(options.body);
      window.interactionCalls.push(call.method);
      let result = { data: [] };
      if (call.method === "host/thread/history") {
        const snapshot = window.interactionSnapshot;
        result =
          !call.params.revision || window.interactionRefresh
            ? snapshot
            : { ...snapshot, history: { ...snapshot.history, mode: "delta", turns: [], questionTurns: [] } };
        if (window.interactionRefresh) window.interactionReads++;
        window.interactionRefresh = false;
      } else if (["turn/steer", "turn/start"].includes(call.method)) {
        window.answerCalls++;
        window.answerPayload = JSON.stringify(call.params);
        await new Promise((resolve) => {
          window.finishAnswer = resolve;
        });
        result = { turn: { id: "interactive-turn", status: "inProgress" } };
      }
      return Response.json({ type: "rpc/result", id: call.id, result });
    };
  }, snapshot);
  await page.evaluate(() => window.__pandaForceDebug.openThread("interactive-history"));
  const card = page.locator('[data-async-question-card][data-item-id="interactive-question"]');
  await card.waitFor();
  const refresh = async () => {
    const before = await page.evaluate(() => {
      const before = window.interactionReads;
      window.interactionRefresh = true;
      window.dispatchEvent(new Event("focus"));
      return before;
    });
    try {
      await page.waitForFunction((before) => window.interactionReads > before, before);
    } catch (error) {
      console.log(
        await page.evaluate(() => ({
          connected: window.__pandaForceDebug.state.connected,
          active: window.__pandaForceDebug.state.active?.id,
          history: window.__pandaForceDebug.state.active?.history,
          calls: window.interactionCalls,
        })),
      );
      throw error;
    }
    await page.waitForTimeout(250);
  };
  await card.locator(".user-input-option").first().tap();
  await card.locator("textarea:visible").fill("End to end on mobile");
  await card.evaluate((node) => {
    window.originalInteractiveCard = node;
  });
  await refresh();
  assert.equal(
    await card.locator('[type=radio][value="0"]').isChecked(),
    true,
    "History refresh must retain the selected option",
  );
  assert.equal(await card.locator("textarea:visible").inputValue(), "End to end on mobile");
  assert.equal(
    await card.evaluate((node) => node === window.originalInteractiveCard),
    true,
    "History reuses the interactive root and handlers",
  );
  assert.equal(
    await card.locator("textarea:visible").evaluate((node) => node === document.activeElement),
    true,
    "Draft focus survives projection",
  );

  const option = card.locator(".user-input-option").nth(1);
  await option.scrollIntoViewIfNeeded();
  if (browserName === "chromium") {
    const session = await context.newCDPSession(page);
    const box = await option.boundingBox();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 30, y: box.y + 20 }],
    });
    await refresh();
    assert.equal(await card.evaluate((node) => node === window.originalInteractiveCard), true);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    // WebKit does not expose native swipe injection. A real tap still verifies
    // hit testing; the viewport fixture separately covers touch event ordering.
    await option.tap();
    await refresh();
  }
  await page.waitForTimeout(250);
  assert.equal(await card.locator('[type=radio][value="1"]').isChecked(), true);
  await card.locator("[type=submit]").tap();
  await page.waitForFunction(() => window.answerCalls === 1);
  await refresh();
  assert.equal(await card.getAttribute("data-status"), "submitting");
  assert.equal(await card.locator("[type=submit]").isDisabled(), true);
  await page.evaluate(() => window.finishAnswer());
  await page.waitForFunction(
    () => document.querySelector('[data-item-id="interactive-question"]').dataset.status === "submitted",
  );
  await refresh();
  assert.equal(await card.getAttribute("open"), null);
  assert.equal(await page.evaluate(() => window.answerCalls), 1);
  assert.match(await page.evaluate(() => window.answerPayload), /Arrow button/);
  assert.match(await page.evaluate(() => window.answerPayload), /End to end on mobile/);
}
