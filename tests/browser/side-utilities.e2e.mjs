import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();
const base = runtime.base;
const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, colorScheme: "dark" });
const originalWait = page.waitForFunction.bind(page);
page.waitForFunction = async (...args) => {
  try {
    return await originalWait(...args);
  } catch (error) {
    console.error(
      "Wait failed:",
      String(args[0]),
      await page.evaluate(() => ({
        active: globalThis.__pandaForceDebug.state.active?.id,
        errors: document.querySelector("#persistentErrors")?.textContent,
      })),
    );
    throw error;
  }
};
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function waitForTerminalOutput(kind, expected) {
  try {
    await page.waitForFunction(
      ({ kind, expected }) => {
        const term = globalThis.__codexTerminals?.[kind]?.term;
        return (
          term &&
          [...Array(term.buffer.active.length)].some(
            (_, index) => term.buffer.active.getLine(index)?.translateToString(true).trim() === expected,
          )
        );
      },
      { kind, expected },
      { timeout: 10000 },
    );
  } catch (error) {
    const output = await page.evaluate((kind) => {
      const term = globalThis.__codexTerminals?.[kind]?.term;
      return term
        ? [...Array(term.buffer.active.length)]
            .map((_, index) => term.buffer.active.getLine(index)?.translateToString(true) || "")
            .join("\n")
        : "<terminal unavailable>";
    }, kind);
    throw new Error(`${kind} terminal did not render ${expected}. Current output:\n${output}`, { cause: error });
  }
}
await page.goto(base + "/new", { waitUntil: "networkidle" });
await page.waitForFunction(() => globalThis.__pandaForceDebug?.notify);
await page.click("#toggleSidePanel");
await page.click('[data-side-panel-action="terminal"]');
await page.waitForFunction(
  () =>
    document.querySelector("#sideTerminalHost")?.dataset.connected === "true" &&
    document.querySelector("#sideTerminalHost .xterm"),
);
await page.locator("#sideTerminalHost .xterm-helper-textarea").focus();
await page.keyboard.type("printf 'SIDE_TERMINAL_OK\\n'");
await page.keyboard.press("Enter");
await waitForTerminalOutput("side", "SIDE_TERMINAL_OK");
const terminal = await page.evaluate(() => ({
  panelVisible: !document.querySelector("#sideTerminalPanel").hidden,
  hostVisible: !document.querySelector("#sideTerminalHost").hidden,
  connected: document.querySelector("#sideTerminalHost").dataset.connected,
  title: document.querySelector("#utilityTab").textContent.trim(),
  output: [...Array(globalThis.__codexTerminals.side.term.buffer.active.length)]
    .map(
      (_, index) => globalThis.__codexTerminals.side.term.buffer.active.getLine(index)?.translateToString(true) || "",
    )
    .join("\n"),
  hasOutputLine: [...Array(globalThis.__codexTerminals.side.term.buffer.active.length)].some(
    (_, index) =>
      globalThis.__codexTerminals.side.term.buffer.active.getLine(index)?.translateToString(true).trim() ===
      "SIDE_TERMINAL_OK",
  ),
}));
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  api.mutations.set("active", { id: "parent-thread", cwd: api.state.config.defaultCwd, turns: [] });
  api.workbench.threadOpened("parent-thread");
});
await page.evaluate(() =>
  globalThis.__pandaForceDebug.notify("item/started", {
    turnId: "side-task-turn",
    item: {
      id: "spawn-side-task",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["child-thread"],
      prompt: "Inspect the browser compatibility issue.",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      agentsStates: { "child-thread": { status: "running", message: "Checking redirects" } },
    },
  }),
);
await page.click("#openSidePanelTab");
await page.click('[data-side-panel-action="side-task"]');
await page.waitForFunction(() => document.querySelector("#sideTaskList .side-task-card"));
const sideTask = await page.evaluate(() => ({
  panelVisible: !document.querySelector("#sideTaskPanel").hidden,
  title: document.querySelector("#utilityTab").textContent.trim(),
  taskTitle: document.querySelector(".side-task-card strong")?.textContent.trim(),
  taskBody: document.querySelector(".side-task-card small")?.textContent.trim(),
  taskStatus: document.querySelector(".side-task-status")?.textContent.trim(),
}));
await page.evaluate(() => {
  const { state } = globalThis.__pandaForceDebug,
    cwd = state.active?.cwd || state.config.defaultCwd;
  globalThis.__pandaForceDebug.mutations.set("transport", "ws");
  globalThis.__pandaForceDebug.mutations.set("ws", {
    readyState: WebSocket.OPEN,
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        const pending = state.pending.get(request.id);
        if (!pending) return;
        globalThis.__pandaForceDebug.mutations.collection("pending").delete(request.id);
        if (request.method === "host/thread/history") {
          pending.reject(new Error("Unsupported method"));
          return;
        }
        if (request.method === "thread/read" && request.params.threadId === "child-thread")
          pending.resolve({
            thread: {
              id: "child-thread",
              name: "gpt-5.6-terra",
              cwd,
              source: "local",
              turns: [
                {
                  id: "child-turn",
                  items: [
                    { id: "child-agent", type: "agentMessage", phase: "final_answer", text: "Child task result" },
                  ],
                },
              ],
            },
          });
        else pending.reject(new Error(`Unexpected RPC ${request.method}`));
      });
    },
  });
});
await page.click(".side-task-card");
await page.waitForFunction(
  () =>
    globalThis.__pandaForceDebug.state.active?.id === "child-thread" &&
    document.querySelector(".assistant-response .message-text")?.textContent.includes("Child task result"),
);
const sideTaskNavigation = await page.evaluate(() => ({
  activeId: globalThis.__pandaForceDebug.state.active?.id,
  storedId: localStorage.getItem("panda-force-active-thread"),
  heading: document.querySelector("#threadTitle")?.textContent.trim(),
  response: document.querySelector(".assistant-response .message-text")?.textContent.trim(),
}));
await page.screenshot({ path: join(tmpdir(), "panda-force-side-task-open.png"), fullPage: false });
await page.evaluate(() =>
  globalThis.__pandaForceDebug.notify("item/started", {
    turnId: "missing-side-task-turn",
    item: {
      id: "missing-side-task",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      receiverThreadIds: ["missing-child-thread"],
      prompt: "Unavailable child task",
      model: "gpt-5.6-terra",
      agentsStates: { "missing-child-thread": { status: "running" } },
    },
  }),
);
await page.click("#openSidePanelTab");
await page.click('[data-side-panel-action="side-task"]');
await page.click('.side-task-card[data-thread-id="missing-child-thread"]');
await page.waitForFunction(() =>
  document.querySelector("#persistentErrors")?.textContent.includes("Unexpected RPC thread/read"),
);
const failedSideTaskNavigation = await page.evaluate(() => ({
  activeId: globalThis.__pandaForceDebug.state.active?.id,
  storedId: localStorage.getItem("panda-force-active-thread"),
  heading: document.querySelector("#threadTitle")?.textContent.trim(),
  toast: document.querySelector("#persistentErrors")?.textContent.trim(),
  disabled: document.querySelector('.side-task-card[data-thread-id="missing-child-thread"]')?.disabled,
  busy: document.querySelector('.side-task-card[data-thread-id="missing-child-thread"]')?.getAttribute("aria-busy"),
}));
await page.click("#openSidePanelTab");
await page.click('[data-side-panel-action="terminal"]');
const restoredTerminal = await page.evaluate(() => ({
  panelVisible: !document.querySelector("#sideTerminalPanel").hidden,
  output: [...Array(globalThis.__codexTerminals.side.term.buffer.active.length)]
    .map(
      (_, index) => globalThis.__codexTerminals.side.term.buffer.active.getLine(index)?.translateToString(true) || "",
    )
    .join("\n"),
  hasOutputLine: [...Array(globalThis.__codexTerminals.side.term.buffer.active.length)].some(
    (_, index) =>
      globalThis.__codexTerminals.side.term.buffer.active.getLine(index)?.translateToString(true).trim() ===
      "SIDE_TERMINAL_OK",
  ),
}));
console.log(
  JSON.stringify(
    { terminal, sideTask, sideTaskNavigation, failedSideTaskNavigation, restoredTerminal, errors },
    null,
    2,
  ),
);
await browser.close();
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.ok(terminal.panelVisible, "Condition: !terminal.panelVisible");
  qualityAssert.ok(terminal.hostVisible, "Condition: !terminal.hostVisible");
  qualityAssert.equal(terminal.connected, "true", "Condition: terminal.connected!=='true'");
  qualityAssert.equal(terminal.title, "Terminal", "Condition: terminal.title!=='Terminal'");
  qualityAssert.ok(terminal.hasOutputLine, "Condition: !terminal.hasOutputLine");
}
{
  qualityAssert.ok(sideTask.panelVisible, "Condition: !sideTask.panelVisible");
  qualityAssert.equal(sideTask.title, "Side tasks", "Condition: sideTask.title!=='Side tasks'");
  qualityAssert.equal(sideTask.taskTitle, "gpt-5.6-terra", "Condition: sideTask.taskTitle!=='gpt-5.6-terra'");
  qualityAssert.equal(sideTask.taskBody, "Checking redirects", "Condition: sideTask.taskBody!=='Checking redirects'");
  qualityAssert.equal(sideTask.taskStatus, "running", "Condition: sideTask.taskStatus!=='running'");
}
{
  qualityAssert.equal(
    sideTaskNavigation.activeId,
    "child-thread",
    "Condition: sideTaskNavigation.activeId!=='child-thread'",
  );
  qualityAssert.equal(
    sideTaskNavigation.storedId,
    "child-thread",
    "Condition: sideTaskNavigation.storedId!=='child-thread'",
  );
  qualityAssert.equal(
    sideTaskNavigation.heading,
    "gpt-5.6-terra",
    "Condition: sideTaskNavigation.heading!=='gpt-5.6-terra'",
  );
  qualityAssert.equal(
    sideTaskNavigation.response,
    "Child task result",
    "Condition: sideTaskNavigation.response!=='Child task result'",
  );
}
{
  qualityAssert.equal(
    failedSideTaskNavigation.activeId,
    "child-thread",
    "Condition: failedSideTaskNavigation.activeId!=='child-thread'",
  );
  qualityAssert.equal(
    failedSideTaskNavigation.storedId,
    "child-thread",
    "Condition: failedSideTaskNavigation.storedId!=='child-thread'",
  );
  qualityAssert.equal(
    failedSideTaskNavigation.heading,
    "gpt-5.6-terra",
    "Condition: failedSideTaskNavigation.heading!=='gpt-5.6-terra'",
  );
  qualityAssert.ok(
    failedSideTaskNavigation.toast.includes("Unexpected RPC thread/read"),
    "Condition: !failedSideTaskNavigation.toast.includes('Unexpected RPC thread/read')",
  );
  qualityAssert.ok(!failedSideTaskNavigation.disabled, "Condition: failedSideTaskNavigation.disabled");
  qualityAssert.equal(failedSideTaskNavigation.busy, null, "Condition: failedSideTaskNavigation.busy!==null");
}
{
  qualityAssert.ok(restoredTerminal.panelVisible, "Condition: !restoredTerminal.panelVisible");
  qualityAssert.ok(restoredTerminal.hasOutputLine, "Condition: !restoredTerminal.hasOutputLine");
}
