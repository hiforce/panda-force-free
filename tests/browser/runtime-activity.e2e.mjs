import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();
const base = runtime.base;
const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => globalThis.__pandaForceDebug?.notify);
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  (api.mutations.set("active", {
    id: "runtime-thread",
    name: "Runtime thread",
    cwd: api.state.config.defaultCwd,
    turns: [],
  }),
    api.workbench.threadOpened(api.state.active.id));
  api.notify("item/started", {
    turnId: "runtime-turn",
    item: { id: "runtime-command", type: "commandExecution", command: "bun test" },
  });
  api.notify("item/commandExecution/outputDelta", {
    turnId: "runtime-turn",
    itemId: "runtime-command",
    delta: "starting tests\n",
  });
  api.notify("item/started", {
    turnId: "runtime-turn",
    item: { id: "runtime-interactive", type: "commandExecution", command: "", commandActions: [] },
  });
  api.notify("item/commandExecution/terminalInteraction", {
    turnId: "runtime-turn",
    itemId: "runtime-interactive",
    processId: "pty-1",
    stdin: "echo interactive\r",
  });
  api.notify("item/fileChange/patchUpdated", {
    turnId: "runtime-turn",
    itemId: "runtime-file",
    changes: [{ path: "/tmp/runtime.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
  });
});
await page.waitForFunction(() =>
  document.querySelector('[data-item-id="runtime-command"] .activity-name')?.textContent.includes("Running command"),
);
await page.click('[data-item-id="runtime-command"]');
await page.click('[data-item-id="runtime-interactive"]');
await page.click('[data-item-id="runtime-file"]');
const running = await page.evaluate(() => ({
  commandLabel: document.querySelector('[data-item-id="runtime-command"] .activity-name')?.textContent.trim(),
  commandOutput: document.querySelector('[data-item-id="runtime-command"] + .activity-output pre')?.textContent,
  interactiveCommand: document.querySelector(
    '[data-item-id="runtime-interactive"] + .activity-output .command-shell-command code',
  )?.textContent,
  fileLabel: document.querySelector('[data-item-id="runtime-file"] .activity-label')?.textContent.trim(),
  filePath: document
    .querySelector('[data-item-id="runtime-file"] + .activity-output .file-change-output-head span:nth-of-type(2)')
    ?.textContent.trim(),
  fileDiff: document.querySelector('[data-item-id="runtime-file"] + .activity-output')?.textContent,
  fileExpanded: document.querySelector('[data-item-id="runtime-file"]')?.getAttribute("aria-expanded"),
}));
await page.evaluate(() =>
  globalThis.__pandaForceDebug.notify("item/completed", {
    turnId: "runtime-turn",
    item: {
      id: "runtime-file",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/tmp/runtime.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
    },
  }),
);
await page.waitForFunction(() =>
  document.querySelector('[data-item-id="runtime-file"] .activity-label')?.textContent.includes("Edited"),
);
const completedLabel = await page.locator('[data-item-id="runtime-file"] .activity-label').textContent();
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  api.syncTurnSnapshot({
    id: "synced-turn",
    status: "inProgress",
    itemsView: "full",
    items: [
      {
        id: "synced-command",
        type: "commandExecution",
        status: "inProgress",
        command: "bun run build",
        aggregatedOutput: "building\n",
      },
      { id: "synced-user", type: "userMessage", content: [{ type: "text", text: "Steer this task from the CLI." }] },
      {
        id: "synced-file",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "/tmp/host-live.ts",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-export const live = false;\n+export const live = true;",
          },
        ],
      },
    ],
  });
});
await page.click('[data-item-id="synced-command"]');
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  api.syncTurnSnapshot({
    id: "synced-turn",
    status: "inProgress",
    itemsView: "full",
    items: [
      {
        id: "synced-command",
        type: "commandExecution",
        status: "inProgress",
        command: "bun run build",
        aggregatedOutput: "building\nbundled\n",
      },
      { id: "synced-user", type: "userMessage", content: [{ type: "text", text: "Steer this task from the CLI." }] },
      {
        id: "synced-file",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "/tmp/host-live.ts",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-export const live = false;\n+export const live = true;",
          },
        ],
      },
    ],
  });
});
await page.click('[data-item-id="synced-file"]');
const syncing = await page.evaluate(() => ({
  output: document.querySelector('[data-item-id="synced-command"] + .activity-output pre')?.textContent,
  expanded: document.querySelector('[data-item-id="synced-command"]')?.getAttribute("aria-expanded"),
  stopping: document.querySelector("#sendButton")?.classList.contains("stop"),
  turnId: document.querySelector("#sendButton")?.dataset.turnId,
  steering: [...document.querySelectorAll(".user-message")].some(
    (node) => node.textContent === "Steer this task from the CLI.",
  ),
  liveFile: document.querySelector('[data-item-id="synced-file"] + .activity-output')?.textContent,
  addedLine: document.querySelector('[data-item-id="synced-file"] + .activity-output .review-line.add')?.textContent,
  deletedLine: document.querySelector('[data-item-id="synced-file"] + .activity-output .review-line.delete')
    ?.textContent,
  addedBackground: getComputedStyle(
    document.querySelector('[data-item-id="synced-file"] + .activity-output .review-line.add'),
  ).backgroundColor,
  deletedBackground: getComputedStyle(
    document.querySelector('[data-item-id="synced-file"] + .activity-output .review-line.delete'),
  ).backgroundColor,
}));
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  api.syncTurnSnapshot({
    id: "synced-turn",
    status: "completed",
    itemsView: "full",
    items: [
      {
        id: "synced-command",
        type: "commandExecution",
        status: "completed",
        command: "bun run build",
        aggregatedOutput: "building\nbundled\n",
        exitCode: 0,
      },
    ],
  });
});
await page.locator('#sessionToolShortcuts [data-session-tool="changes"]').click();
await page.click("#reviewTab");
const recovered = await page.evaluate(() => ({
  stopped: !document.querySelector("#sendButton")?.classList.contains("stop"),
  reviewPath: document.querySelector(".review-file-name")?.textContent,
  reviewText: document.querySelector("#changeList")?.textContent,
  reviewSource: globalThis.__pandaForceDebug.state.activeReview?.source,
}));
await page.evaluate(() => {
  const root = document.querySelector("#conversation"),
    filler = document.createElement("div");
  filler.style.height = "2400px";
  filler.dataset.openThreadScrollFixture = "";
  root.append(filler);
  root.scrollTop = 0;
  globalThis.__pandaForceDebug.scrollOpenedThreadToBottom();
});
await page.waitForFunction(() => {
  const root = document.querySelector("#conversation");
  return root.scrollHeight - root.scrollTop - root.clientHeight < 2;
});
const openedThreadScrollGap = await page.evaluate(() => {
  const root = document.querySelector("#conversation");
  return root.scrollHeight - root.scrollTop - root.clientHeight;
});
console.log(JSON.stringify({ running, completedLabel, syncing, recovered, openedThreadScrollGap, errors }, null, 2));
await browser.close();
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(running.commandLabel, "Running command", "Condition: running.commandLabel!=='Running command'");
  qualityAssert.equal(
    running.commandOutput,
    "starting tests\n",
    "Condition: running.commandOutput!=='starting tests\\n'",
  );
  qualityAssert.equal(
    running.interactiveCommand,
    "echo interactive",
    "Condition: running.interactiveCommand!=='echo interactive'",
  );
  qualityAssert.equal(running.fileLabel, "Editing files", "Condition: running.fileLabel!=='Editing files'");
  qualityAssert.ok(running.filePath?.endsWith("runtime.ts"), "Condition: !running.filePath?.endsWith('runtime.ts')");
  qualityAssert.ok(running.fileDiff?.includes("+new"), "Condition: !running.fileDiff?.includes('+new')");
  qualityAssert.equal(running.fileExpanded, "true", "Condition: running.fileExpanded!=='true'");
  qualityAssert.equal(completedLabel?.trim(), "Edited a file", "Condition: completedLabel?.trim()!=='Edited a file'");
  qualityAssert.equal(syncing.output, "building\nbundled\n", "Condition: syncing.output!=='building\\nbundled\\n'");
  qualityAssert.equal(syncing.expanded, "true", "Condition: syncing.expanded!=='true'");
  qualityAssert.ok(syncing.stopping, "Condition: !syncing.stopping");
  qualityAssert.equal(syncing.turnId, "synced-turn", "Condition: syncing.turnId!=='synced-turn'");
  qualityAssert.ok(syncing.steering, "Condition: !syncing.steering");
  qualityAssert.ok(
    syncing.liveFile?.includes("host-live.ts"),
    "Condition: !syncing.liveFile?.includes('host-live.ts')",
  );
  qualityAssert.ok(
    syncing.addedLine?.includes("+export const live = true;"),
    "Condition: !syncing.addedLine?.includes('+export const live = true;')",
  );
  qualityAssert.ok(
    syncing.deletedLine?.includes("−export const live = false;"),
    "Condition: !syncing.deletedLine?.includes('−export const live = false;')",
  );
  qualityAssert.ok(
    !(syncing.addedBackground === syncing.deletedBackground),
    "Condition: syncing.addedBackground===syncing.deletedBackground",
  );
  qualityAssert.ok(recovered.stopped, "Condition: !recovered.stopped");
  qualityAssert.ok(
    recovered.reviewPath?.endsWith("host-live.ts"),
    "Condition: !recovered.reviewPath?.endsWith('host-live.ts')",
  );
  qualityAssert.ok(
    recovered.reviewText?.includes("export const live = true;"),
    "Condition: !recovered.reviewText?.includes('export const live = true;')",
  );
  qualityAssert.ok(
    recovered.reviewText?.includes("export const live = false;"),
    "Condition: !recovered.reviewText?.includes('export const live = false;')",
  );
  qualityAssert.equal(recovered.reviewSource, "fileChange", "Condition: recovered.reviewSource!=='fileChange'");
  qualityAssert.ok(!(openedThreadScrollGap >= 2), "Condition: openedThreadScrollGap>=2");
}
