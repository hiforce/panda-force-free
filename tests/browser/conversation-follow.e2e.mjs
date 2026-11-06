import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

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
  assert.ok(
    Math.abs((await page.locator("#conversation").evaluate((view) => view.scrollTop)) - before) < 2,
    "Reading earlier messages must not be interrupted by delayed content growth",
  );
  await page.locator("#conversationScrollBottom").click();
  await atBottom();
  assert.deepEqual(errors, []);
  console.log(
    "Conversation follow: explicit send, streamed content, late growth and viewport changes reach the bottom; reading history stays put.",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
