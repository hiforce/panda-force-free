import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";
import { createConversationHistory } from "../../src/server/conversation/history.js";

const fixture = await createBrowserFixture();
const browser = await fixture.launchBrowser({ ...launchOptions(), ignoreDefaultArgs: ["--hide-scrollbars"] });
const directory = ".artifacts/session-workspace-layout";
await mkdir(directory, { recursive: true });
const measurements = [],
  errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1861, height: 888 }, colorScheme: "light" });
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("panda-force-theme", "light");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // Authoritative paginated history keeps resize and background refresh checks deterministic.
  const turns = Array.from({ length: 40 }, (_, index) => ({
    id: "layout-turn-" + index,
    status: "completed",
    items: [
      {
        id: "layout-user-" + index,
        type: "userMessage",
        content: [{ type: "text", text: "Review the workspace layout and verify the release." }],
      },
      {
        id: "layout-commentary-" + index,
        type: "agentMessage",
        phase: "commentary",
        text: "I’m checking the conversation, composer and side panels together.",
      },
      {
        id: "layout-command-" + index,
        type: "commandExecution",
        status: "completed",
        command: "bun test tests/unit/conversation/history.test.ts --reporter=verbose",
        aggregatedOutput: "All conversation history checks passed.",
        exitCode: 0,
      },
      {
        id: "layout-final-" + index,
        type: "agentMessage",
        phase: "final_answer",
        text:
          "The workspace review is complete. The conversation and composer should share the same centered reading column.\n\n" +
          "- Keep messages aligned when either side panel is collapsed.\n- Preserve readable spacing and the draft on smaller screens.\n\n" +
          "```js\nconst options = { conversation: 'A long code line verifies local scrolling without widening the page', composer: 'aligned' };\n```\n\n" +
          "Ready for the next step. This is sample content, with no private project information.",
      },
    ],
  }));
  let visibleTurns = turns,
    historyVersion = "long";
  const history = createConversationHistory({
    readThread: async () => ({
      id: "old-alpha",
      name: "Workspace review",
      cwd: fixture.alpha,
      status: { type: "idle" },
      tokenUsage: {
        total: { totalTokens: 124800, inputTokens: 96000, outputTokens: 28800, cachedInputTokens: 64000 },
        last: { totalTokens: 76200 },
        modelContextWindow: 200000,
      },
      turns: visibleTurns,
    }),
    fingerprint: () => "layout-fixture-" + historyVersion,
  });
  let historyReads = 0;
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "host/thread/history" && call.params?.threadId === "old-alpha") {
      historyReads++;
      // Seed a full page so the cached turn-window expansion is deterministic.
      const params = !call.params.revision && !call.params.cursor ? { ...call.params, limit: 100 } : call.params;
      await route.fulfill({ json: { type: "rpc/result", id: call.id, result: await history.read(params) } });
    } else await route.continue();
  });
  await page.goto(fixture.base + "/task/old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".assistant-response").last().waitFor();
  assert.ok(historyReads > 0);
  const hiddenTurns = Number(await page.locator(".load-older").getAttribute("data-earlier-count"));
  assert.ok(hiddenTurns > 0, "The first window must contain cached turns to reveal");
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  assert.equal(await page.locator(".load-older").innerText(), `加载更早消息（${hiddenTurns}）`);
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
  const visibleBefore = await page.locator(".native-turn-timeline").count();
  const cachedFeedback = await page.locator(".load-older").evaluate((button) => {
    button.click();
    return { disabled: button.disabled, busy: button.getAttribute("aria-busy"), label: button.innerText };
  });
  assert.deepEqual(cachedFeedback, { disabled: true, busy: "true", label: "Loading earlier messages…" });
  await page.waitForFunction(
    (before) => document.querySelectorAll(".native-turn-timeline").length > before,
    visibleBefore,
  );
  const settle = async () => {
    // A completed request may still be waiting for an active gesture to finish.
    await page.waitForFunction(() => !document.querySelector('#conversation .load-older[aria-busy="true"]'));
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#app")
          .getAnimations({ subtree: true })
          .some(
            (animation) =>
              animation.playState === "running" && Number.isFinite(animation.effect?.getTiming().iterations),
          ),
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const inspect = async (label, scrollable = true) => {
    await settle();
    const result = await page.evaluate(() => {
      const bounds = (selector) => {
        const nodes = document.querySelectorAll(selector);
        const box = nodes[nodes.length - 1].getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
      };
      const scroller = document.querySelector("#conversation");
      const replies = scroller.querySelectorAll(".native-turn-timeline");
      const lastReply = replies[replies.length - 1].getBoundingClientRect();
      const lastText = replies[replies.length - 1]
        .querySelector(".assistant-response .message-text")
        .getBoundingClientRect();
      return {
        viewport: innerWidth,
        shell: bounds(".conversation-shell"),
        scroller: bounds("#conversation"),
        composer: bounds("#composer"),
        user: bounds("#conversation > .user-turn"),
        reply: { left: lastReply.left, right: lastReply.right, width: lastReply.width },
        text: { left: lastText.left, right: lastText.right },
        scrollable: scroller.scrollHeight > scroller.clientHeight,
        scrollbarGutters: scroller.offsetWidth - scroller.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        contentOverflow: scroller.scrollWidth > scroller.clientWidth,
      };
    });
    measurements.push({ label, ...result });
    await page.screenshot({ path: directory + "/" + label + ".png" });
    const near = (actual, expected, name) =>
      assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${name}\n${JSON.stringify(result, null, 2)}`);
    near(result.reply.left, result.composer.left, "reply and composer left edges");
    near(result.reply.right, result.composer.right, "reply and composer right edges");
    near(result.user.left, result.composer.left, "user turn starts on the reading column");
    near(result.user.right, result.composer.right, "user turn ends on the reading column");
    near(result.text.left, result.reply.left, "message body starts on the reading column");
    near(result.text.right, result.reply.right, "message body fills the reading column");
    near(
      (result.composer.left + result.composer.right) / 2,
      (result.shell.left + result.shell.right) / 2,
      "content is centered between the side panels",
    );
    near(result.scroller.left, result.shell.left, "scroller starts at the main column edge");
    near(result.scroller.right, result.shell.right, "scrollbar belongs at the main column edge");
    assert.equal(result.scrollable, scrollable, label);
    assert.equal(result.pageOverflow, false, label);
    assert.equal(result.contentOverflow, false, label);
    assert.ok(result.composer.bottom <= (await page.viewportSize()).height + 1, label);
  };
  await page.locator("#prompt").fill("Keep this draft while resizing the workspace.");
  await page.locator("#prompt").evaluate((input) => {
    input.focus();
    input.setSelectionRange(5, 10);
  });
  await inspect("desktop-1861-both-panels");
  await page.locator("#conversation").evaluate((element) => {
    element.style.scrollbarWidth = "none";
  });
  await inspect("desktop-overlay-scrollbar");
  await page.locator("#conversation").evaluate((element) => {
    element.style.removeProperty("scrollbar-width");
  });
  for (const [width, height] of [
    [2560, 1440],
    [1920, 1080],
    [1440, 960],
    [1081, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await inspect(`desktop-${width}-both-panels`);
  }
  await page.setViewportSize({ width: 1861, height: 888 });
  await page.locator("#sessionInfoButton").click();
  await inspect("desktop-left-panel");
  await page.locator("#toggleSidebar").click();
  await inspect("desktop-no-panels");
  await page.locator("#sessionInfoButton").click();
  await inspect("desktop-right-panel");
  await page.locator("#workspaceNavigationToggle").click();
  await inspect("desktop-both-panels-restored");
  await page.locator("#prompt").focus();
  await page.locator("#prompt").evaluate((input) => input.setSelectionRange(5, 10));
  for (const [width, height] of [
    [820, 900],
    [740, 390],
    [430, 932],
    [390, 844],
    [320, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await inspect(`mobile-${width}`);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft while resizing the workspace.");
    assert.equal(
      await page
        .locator("#prompt")
        .evaluate(
          (input) => document.activeElement === input && input.selectionStart === 5 && input.selectionEnd === 10,
        ),
      true,
    );
  }
  // The same scroll owner must retain native history pagination and jump-to-latest behavior.
  const beforePagination = historyReads;
  for (let attempt = 0; attempt < 4 && historyReads === beforePagination; attempt++) {
    await page.locator("#conversation .load-older").click();
    await settle();
  }
  assert.ok(historyReads > beforePagination, "Earlier messages must still load from paginated history");
  // The visible window depends on available height; load additional pages until the oldest turn arrives.
  for (
    let attempt = 0;
    attempt < 10 && !(await page.locator('#conversation [data-user-turn-id="layout-turn-0"]').count());
    attempt++
  ) {
    const previousReads = historyReads;
    await page.locator("#conversation .load-older").click();
    await settle();
    assert.ok(historyReads > previousReads, "Each page must use the history API");
  }
  assert.equal(await page.locator('#conversation [data-user-turn-id="layout-turn-0"]').count(), 1);
  await page.evaluate(() => {
    document.querySelector("#conversation").scrollTop = 0;
  });
  await page.locator("#conversationScrollBottom").waitFor({ state: "visible" });
  await page.locator("#conversationScrollBottom").click();
  await page.waitForFunction(() => {
    const element = document.querySelector("#conversation");
    return element.scrollHeight - element.clientHeight - element.scrollTop < 2;
  });
  await page.setViewportSize({ width: 1920, height: 1200 });
  visibleTurns = [turns.at(-1)];
  historyVersion = "short";
  history.invalidate("old-alpha");
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.waitForFunction(() => document.querySelectorAll("#conversation > .native-turn-timeline").length === 1);
  await inspect("desktop-short-conversation", false);
  assert.deepEqual(errors, []);
  await writeFile(directory + "/measurements.json", JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ layouts: measurements.length, historyReads, errors }));
} finally {
  await browser.close();
}
