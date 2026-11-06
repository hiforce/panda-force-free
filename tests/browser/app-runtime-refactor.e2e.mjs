import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const fixture = await createAppFixture();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await fixture.signIn(context);
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("panda-force-locale", "en");
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + "/task/old-alpha");
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  const cached = await page.evaluate(async () => {
    const cache = globalThis.__pandaForceDebug.persistentConversationCache;
    await cache.put({
      id: "empty-runtime-cache",
      updatedAt: Date.now() / 1000,
      status: { type: "active" },
      history: { revision: "r1" },
      turns: [
        {
          id: "previous",
          status: "completed",
          items: [{ id: "answer", type: "agentMessage", text: "Previous answer" }],
        },
        { id: "empty-running", status: "inProgress", items: [] },
      ],
    });
    const result = await cache.get("empty-runtime-cache");
    await cache.remove("empty-runtime-cache");
    return result;
  });
  assert.equal(cached.turns.at(-1).id, "empty-running");
  assert.equal(cached.turns.at(-1).status, "inProgress");
  const activity = await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug,
      threadId = "old-alpha",
      turnId = "activity-check";
    api.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "remote-file-check",
        type: "userMessage",
        content: [{ type: "text", text: 'Attached file: "remote.txt"\nhttps://example.com/files/remote.txt' }],
      },
    });
    api.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "command-check",
        type: "commandExecution",
        status: "completed",
        command: "printf check",
        aggregatedOutput: "check",
        exitCode: 0,
      },
    });
    api.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "diff-check",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "/tmp/example.txt",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+<script>window.injected=true</script>",
          },
        ],
      },
    });
    api.notify("turn/diff/updated", {
      threadId,
      turnId,
      diff: "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+<script>window.injected=true</script>",
    });
    return {
      remote: document.querySelector(".user-message-files a")?.href,
      command: document.querySelector(".command-shell")?.textContent,
      diff: document.querySelector(".file-change-inline-diff")?.textContent,
      review: document.querySelector("#changeList").textContent,
      injected: window.injected === true,
    };
  });
  assert.ok(activity.remote.includes("remote.txt"));
  assert.ok(activity.command.includes("printf check"));
  assert.ok(activity.diff.includes("<script>"));
  assert.ok(activity.review.includes("<script>"));
  assert.equal(activity.injected, false);
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("thread/goal/updated", {
      threadId: "old-alpha",
      goal: { id: "goal-check", status: "active", objective: "Review runtime architecture", updatedAt: 200 },
    }),
  );
  await page.locator("#sessionGoalPlan > summary").click();
  await page.locator(".goal-status-toggle").click();
  await page.locator("#goalDialogObjective").fill("Updated runtime objective");
  await page.locator("#saveGoalDialog").click();
  await page.locator("#goalDialog").waitFor({ state: "hidden" });
  assert.ok(
    fixture
      .calls()
      .some((call) => call.method === "thread/goal/set" && call.params.objective === "Updated runtime objective"),
  );
  await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    api.notify("goal/status/changed", {
      threadId: "old-alpha",
      goalId: "goal-check",
      status: "completed",
      updatedAt: 202,
    });
    api.notify("goal/status/changed", {
      threadId: "old-alpha",
      goalId: "goal-check",
      status: "blocked",
      updatedAt: 201,
    });
  });
  assert.equal(await page.locator("#goalStatus").getAttribute("data-state"), "completed");
  await page.evaluate(() => {
    const file = new File(["draft attachment"], "original-name.txt", { type: "text/plain" }),
      data = new DataTransfer();
    data.items.add(file);
    document
      .querySelector("#prompt")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator('.composer-attachment[data-status="ready"]').waitFor();
  assert.ok((await page.locator("#composerAttachments").innerText()).includes("original-name.txt"));
  await page.locator(".composer-attachment-remove").click();
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("turn/started", {
      threadId: "old-alpha",
      turn: { id: "canonical-turn", status: "inProgress", items: [] },
    }),
  );
  await page.locator("#prompt").fill("Steer the canonical running turn.");
  await page.evaluate(() => {
    document.querySelector("#sendButton").dataset.turnId = "tampered-dom-id";
  });
  await page.locator("#sendButton").click();
  await waitFor(() => fixture.calls().some((call) => call.method === "turn/steer"));
  assert.equal(
    fixture
      .calls()
      .filter((call) => call.method === "turn/steer")
      .at(-1).params.expectedTurnId,
    "canonical-turn",
  );
  const navigation = await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    api.startNewTask();
    return { active: api.state.active, running: api.sessionRuntime.activeTurnId({ id: "old-alpha" }) };
  });
  assert.equal(navigation.active, null);
  assert.equal(navigation.running, "canonical-turn");
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.notify("turn/completed", {
      threadId: "old-alpha",
      turn: { id: "canonical-turn", status: "completed", items: [] },
    }),
  );
  assert.equal(
    await page.evaluate(() => globalThis.__pandaForceDebug.sessionRuntime.activeTurnId({ id: "old-alpha" })),
    "",
  );
  const productionContext = await browser.newContext();
  await fixture.signIn(productionContext);
  await productionContext.addInitScript(() => {
    globalThis.__pandaForceTest = false;
  });
  const productionPage = await productionContext.newPage();
  await productionPage.goto(fixture.base + "/workspace");
  await productionPage.waitForFunction(() => Boolean(globalThis.__pandaForceDebug));
  assert.deepEqual(await productionPage.evaluate(() => Object.keys(globalThis.__pandaForceDebug)), ["snapshot"]);
  assert.equal(await productionPage.evaluate(() => Object.isFrozen(globalThis.__pandaForceDebug)), true);
  await productionContext.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      emptyRunningTurnPersisted: true,
      commandAndDiffRendering: true,
      diffEscaped: true,
      goalEditingAndEventOrdering: true,
      clipboardOriginalName: true,
      domIsNotRuntimeAuthority: true,
      navigationPreservesBackgroundTurn: true,
      backgroundCompletion: true,
      errors,
    }),
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
