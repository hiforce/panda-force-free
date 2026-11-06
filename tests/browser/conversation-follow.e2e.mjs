import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { createConversationHistory } from "../../src/server/conversation/history.js";

async function checkHistoryRefresh(browser, fixture, viewport) {
  const context = await browser.newContext({
    viewport,
    isMobile: viewport.width < 768,
    hasTouch: viewport.width < 768,
  });
  await fixture.signIn(context);
  const page = await context.newPage();
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.__pandaForceDebug?.state.connected);
  const thread = {
    id: "reading-position",
    turns: Array.from({ length: 15 }, (_, index) => ({
      id: `reading-${index}`,
      status: "completed",
      items: [
        {
          id: `reply-${index}`,
          type: "agentMessage",
          text: `Message ${index}.\n\n` + "A paragraph of conversation history.\n\n".repeat(6),
        },
      ],
    })),
  };
  const history = createConversationHistory({ readThread: async () => thread, fingerprint: () => 1 });
  const snapshot = await history.read({ threadId: thread.id });
  await page.evaluate((snapshot) => {
    const api = window.__pandaForceDebug;
    api.state.ws.onmessage = null;
    api.state.events?.close();
    api.mutations.set("transport", "sse");
    api.startNewTask();
    window.__scrollSnapshot = snapshot;
    window.__refreshHistory = false;
    const original = window.fetch;
    window.fetch = async (resource, options = {}) => {
      if (new URL(typeof resource === "string" ? resource : resource.url, location.href).pathname !== "/api/rpc")
        return original(resource, options);
      const call = JSON.parse(options.body);
      let result = { data: [] };
      if (call.method === "host/thread/history") {
        const snapshot = window.__scrollSnapshot;
        result =
          !call.params.revision || window.__refreshHistory
            ? snapshot
            : { ...snapshot, history: { ...snapshot.history, mode: "delta", turns: [] } };
        window.__refreshHistory = false;
      }
      return Response.json({ type: "rpc/result", id: call.id, result });
    };
  }, snapshot);
  await page.evaluate(() => window.__pandaForceDebug.openThread("reading-position"));
  const bottom = () =>
    page.waitForFunction(() => {
      const view = document.querySelector("#conversation");
      return view.scrollHeight - view.scrollTop - view.clientHeight < 2;
    });
  await bottom();
  const anchor = page.locator('[data-turn-id="reading-8"]');
  await anchor.evaluate((node) => {
    const root = document.querySelector("#conversation");
    root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top + 45;
  });
  await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
  const position = () =>
    anchor.evaluate(
      (node) => node.getBoundingClientRect().top - document.querySelector("#conversation").getBoundingClientRect().top,
    );
  const before = await position();
  const refresh = async (label) => {
    await page.evaluate((label) => {
      window.__scrollSnapshot.history.turns.at(-1).items.at(-1).text += `\n\n${label}`;
      window.__refreshHistory = true;
      window.dispatchEvent(new Event("focus"));
    }, label);
    await page.getByText(label, { exact: true }).waitFor();
    await page.waitForTimeout(100);
  };
  await refresh("Appended during a background snapshot refresh");
  const restored = await position();
  assert.ok(
    Math.abs(restored - before) < 2,
    `Refreshing history must preserve the message being read: ${before} -> ${restored}`,
  );
  // A late image above the reader must not move the visible message in Safari.
  await page.locator('[data-item-id="reply-0"]').evaluate((node) => {
    node.style.paddingBottom = "220px";
  });
  await page.waitForTimeout(150);
  assert.ok(
    Math.abs((await position()) - before) < 2,
    "Late content above the reader must preserve the visible anchor",
  );
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 100 });
  await page.waitForTimeout(150);
  assert.ok(
    Math.abs((await position()) - before) < 2,
    "Changing the viewport height must preserve the reading position",
  );
  await page.locator("#conversationScrollBottom").click();
  await bottom();
  await page.locator("#conversation").evaluate((root) => {
    root.scrollTop -= 32;
  });
  await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
  const nearBottomAnchor = page.locator('[data-turn-id="reading-14"]');
  const nearBottomPosition = await nearBottomAnchor.evaluate((node) => node.getBoundingClientRect().top);
  await refresh("Appended after a small deliberate upward scroll");
  assert.ok(
    Math.abs((await nearBottomAnchor.evaluate((node) => node.getBoundingClientRect().top)) - nearBottomPosition) < 2,
    "A small upward scroll must pause following instead of snapping back to the bottom",
  );
  await page.locator("#conversationScrollBottom").click();
  await bottom();
  await refresh("Appended while following the latest messages");
  await bottom();
  await context.close();
}

const fixture = await createBrowserFixture();
const browser = await (process.env.PANDA_FORCE_TEST_BROWSER === "webkit" ? webkit : chromium).launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fixture.signIn(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspaceContextHeader").waitFor({ state: "visible" });
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.__pandaForceDebug?.state.models.length > 0);
  await page.evaluate(() => {
    const api = window.__pandaForceDebug;
    if (api.state.ws) api.state.ws.onmessage = null;
    api.state.events?.close();
    api.mutations.set("transport", "sse");
    const history = document.createElement("article");
    history.id = "scroll-history-fixture";
    history.style.height = "2400px";
    history.textContent = "Earlier conversation history";
    document.querySelector("#conversation").append(history);
    api.scrollOpenedThreadToBottom();
  });
  const atBottom = () =>
    page.waitForFunction(
      () => {
        const view = document.querySelector("#conversation");
        return view.scrollHeight - view.scrollTop - view.clientHeight < 2;
      },
      null,
      { timeout: 4000 },
    );
  await atBottom();
  await page.locator("#conversation").evaluate((view) => {
    view.scrollTop -= 500;
  });
  await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "turn/start")
      await route.fulfill({
        json: {
          type: "rpc/result",
          id: call.id,
          result: { turn: { id: "scroll-follow-turn" } },
        },
      });
    else await route.continue();
  });
  await page.locator("#prompt").fill("Follow this new message to the latest content.\n".repeat(8));
  await page.locator("#sendButton").click();
  await page.locator('.user-turn[data-optimistic-user="true"]').waitFor();
  await atBottom();
  await page.evaluate(() => {
    const api = window.__pandaForceDebug;
    api.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "scroll-follow-turn",
      item: {
        id: "scroll-follow-reply",
        type: "agentMessage",
        phase: "final_answer",
        text: "Latest response.\n\n".repeat(35),
      },
    });
  });
  await page.locator('[data-turn-id="scroll-follow-turn"] [data-local-conversation-final-assistant]').waitFor();
  await atBottom();
  // A decoded image or late font/layout change can grow a turn after its render frame.
  await page
    .locator('[data-turn-id="scroll-follow-turn"] [data-local-conversation-final-assistant]')
    .evaluate((reply) => {
      reply.style.paddingBottom = "650px";
    });
  await atBottom();
  await page.setViewportSize({ width: 1000, height: 640 });
  // Let the responsive sidebar transition settle before isolating content growth.
  await page.waitForTimeout(600);
  await atBottom();
  await page.locator("#conversation").evaluate((view) => {
    view.scrollTop -= 600;
  });
  await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
  const before = await page.locator("#conversation").evaluate((view) => view.scrollTop);
  await page
    .locator('[data-turn-id="scroll-follow-turn"] [data-local-conversation-final-assistant]')
    .evaluate((reply) => {
      reply.style.paddingBottom = "1000px";
    });
  await page.waitForTimeout(150);
  const after = await page.locator("#conversation").evaluate((view) => view.scrollTop);
  assert.ok(
    Math.abs(after - before) < 2,
    `Reading earlier messages must not be interrupted by delayed content growth: ${before} -> ${after}`,
  );
  await page.locator("#conversationScrollBottom").click();
  await atBottom();
  assert.deepEqual(errors, []);
  await checkHistoryRefresh(browser, fixture, { width: 390, height: 844 });
  await checkHistoryRefresh(browser, fixture, { width: 1440, height: 900 });
  console.log(
    "Conversation follow: explicit send, streamed content, late growth and viewport changes reach the bottom; reading history stays put.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
