import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404 (Not Found)")) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(runtime.base, { waitUntil: "networkidle" });
await page.waitForSelector("#newTask");
await page.click("#newTask");
const dialogAfterNewTask = await page.locator("#folderDialog").evaluate((e) => e.open);
await page.click("#composerProjectButton");
await page.waitForSelector("#folderDialog[open]");
await page.waitForSelector(".folder-item");
const folders = await page.locator(".folder-item").count();
await page.click(".folder-item");
const confirmEnabled = await page.locator("#folderConfirm").isEnabled();
await page.click("#folderConfirm");
const selectedPath = await page.locator("#projectPath").textContent();
const workspaceName = await page.locator("#projectName").textContent();
await page.click("#toggleSummaryPanel");
await page.waitForFunction(() => !document.querySelector("#summaryPanel").hidden);
await page.click("#composerProjectButton");
await page.waitForFunction(() => {
  const dialog = document.querySelector("#folderDialog");
  return (
    dialog?.open &&
    (dialog.querySelector(".folder-item") ||
      dialog.querySelector(".list-state")?.textContent?.includes("No subfolders"))
  );
});
if (!(await page.locator("#folderDialog .folder-item").count())) {
  await page.click("#folderUp");
  await page.waitForSelector("#folderDialog[open] .folder-item");
}
await page.click("#folderDialog .folder-item");
await page.click("#folderConfirm");
const nextWorkspaceName = await page.locator("#projectName").textContent();
const nextHeading = await page.locator("#emptyState h1").textContent();
const summarySync = await page.evaluate(() => ({
  workspace: document.querySelector("#summaryWorkspace").textContent,
  branch: document.querySelector("#summaryBranch").textContent,
  open: !document.querySelector("#summaryPanel").hidden,
}));
await page.click("#toggleSummaryPanel");
await page.evaluate(() => {
  const root = document.querySelector("#conversation");
  root.innerHTML = `<div class="message-text" id="smokeMarkdown">${globalThis.__renderAssistantMarkdown("## Formula\n\nInline $E=mc^2$\n\n```js\nconst x = 1;\n```")}</div>`;
});
const markdown = {
  heading: await page.locator("#smokeMarkdown h2").count(),
  katex: await page.locator("#smokeMarkdown .katex").count(),
  code: await page.locator("#smokeMarkdown pre code").count(),
};
await page.screenshot({ path: artifact("browser-smoke.png"), fullPage: false });
console.log(
  JSON.stringify(
    {
      dialogAfterNewTask,
      folders,
      confirmEnabled,
      selectedPath,
      workspaceName,
      nextWorkspaceName,
      nextHeading,
      summarySync,
      markdown,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
{
  qualityAssert.ok(!dialogAfterNewTask, "Condition: dialogAfterNewTask");
  qualityAssert.ok(folders, "Condition: !folders");
  qualityAssert.ok(confirmEnabled, "Condition: !confirmEnabled");
  qualityAssert.ok(workspaceName, "Condition: !workspaceName");
  qualityAssert.ok(nextWorkspaceName, "Condition: !nextWorkspaceName");
  qualityAssert.ok(nextHeading, "Condition: !nextHeading");
  qualityAssert.equal(summarySync.workspace, nextWorkspaceName, "Condition: summarySync.workspace!==nextWorkspaceName");
  qualityAssert.ok(summarySync.open, "Condition: !summarySync.open");
  qualityAssert.ok(markdown.heading, "Condition: !markdown.heading");
  qualityAssert.ok(markdown.katex, "Condition: !markdown.katex");
  qualityAssert.ok(markdown.code, "Condition: !markdown.code");
  qualityAssert.ok(!errors.length, "Condition: errors.length");
}
