import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();
const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(runtime.base, { waitUntil: "networkidle" });
await page.waitForFunction(() => globalThis.__pandaForceDebug);
await page.evaluate(async () => {
  const api = globalThis.__pandaForceDebug;
  (api.mutations.set("active", { id: "thread-review-owner", cwd: api.state.config.defaultCwd || ".", source: "local" }),
    api.workbench.threadOpened(api.state.active.id));
  api.notify("turn/diff/updated", {
    turnId: "turn-old",
    threadId: "thread-review-owner",
    diff: "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1 +1 @@\n-oldValue();\n+oldFixed();\n",
  });
  await api.request({
    id: "approval-old",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-review-owner",
      turnId: "turn-old",
      itemId: "file-old",
      reason: "Review the older turn before applying it.",
    },
  });
  api.notify("turn/diff/updated", {
    turnId: "turn-new",
    threadId: "thread-review-owner",
    diff: "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-newValue();\n+newFixed();\n",
  });
});
await page.waitForSelector(".approval-review-link");
await page.click(".approval-review-link");
await page.waitForFunction(() => !document.querySelector("#reviewPanelContent").hidden);
const selected = await page.evaluate(() => ({
  turnId: globalThis.__pandaForceDebug.state.activeReview?.turnId,
  files: [...document.querySelectorAll(".review-file-name")].map((node) => node.textContent.trim()),
}));
await page.click("#reviewTab");
const selectedAfterTabClick = await page.evaluate(() => ({
  turnId: globalThis.__pandaForceDebug.state.activeReview?.turnId,
  files: [...document.querySelectorAll(".review-file-name")].map((node) => node.textContent.trim()),
}));
await page.click("#newTask");
const reset = await page.evaluate(() => ({
  activeReview: globalThis.__pandaForceDebug.state.activeReview,
  turnDiffCount: globalThis.__pandaForceDebug.state.turnDiffs.size,
  reviewPatchDisabled: document.querySelector("#reviewPatch").disabled,
}));
console.log(JSON.stringify({ selected, selectedAfterTabClick, reset, errors }, null, 2));
await browser.close();
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(selected.turnId, "turn-old", "Condition: selected.turnId!=='turn-old'");
  qualityAssert.equal(selected.files.length, 1, "Condition: selected.files.length!==1");
  qualityAssert.equal(selected.files[0], "src/old.ts", "Condition: selected.files[0]!=='src/old.ts'");
  qualityAssert.equal(selectedAfterTabClick.turnId, "turn-old", "Condition: selectedAfterTabClick.turnId!=='turn-old'");
  qualityAssert.equal(
    selectedAfterTabClick.files[0],
    "src/old.ts",
    "Condition: selectedAfterTabClick.files[0]!=='src/old.ts'",
  );
  qualityAssert.equal(reset.activeReview, null, "Condition: reset.activeReview!==null");
  qualityAssert.equal(reset.turnDiffCount, 0, "Condition: reset.turnDiffCount!==0");
  qualityAssert.ok(reset.reviewPatchDisabled, "Condition: !reset.reviewPatchDisabled");
}
