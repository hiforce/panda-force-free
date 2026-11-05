import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();
const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1018, height: 980 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(runtime.base, { waitUntil: "networkidle" });
const selectedProject = await page.evaluate(() => ({
  trigger: document.querySelector("#composerProjectButton")?.textContent?.trim(),
  triggerHidden: document.querySelector("#composerProjectButton")?.hidden,
  sidebar: document.querySelector("#projectName")?.textContent?.trim(),
  heading: document.querySelector("#emptyState h1")?.textContent?.trim(),
}));
await page.click("#composerProjectButton");
await page.waitForSelector("#folderDialog[open]");
await page.screenshot({ path: artifact("composer-project-picker.png"), fullPage: false });
const picker = await page.evaluate(() => ({
  projectless: document.querySelector("#projectlessOption")?.textContent?.replace(/\s+/g, " ").trim(),
  title: document.querySelector("#folderDialog .folder-head strong")?.textContent?.trim(),
}));
await page.click("#projectlessOption");
await page.locator("#prompt").fill("@file");
await page.waitForSelector("#composerAutocomplete:not([hidden])");
await page.screenshot({ path: artifact("composer-projectless.png"), fullPage: false });
const chooseProjectAction = await page.evaluate(() => ({
  exists: Boolean(document.querySelector('#composerAutocomplete [data-autocomplete-id="choose-project"]')),
  text: document
    .querySelector('#composerAutocomplete [data-autocomplete-id="choose-project"]')
    ?.textContent?.replace(/\s+/g, " ")
    .trim(),
}));
await page.click('#composerAutocomplete [data-autocomplete-id="choose-project"]');
const projectPickerReopened = await page.locator("#folderDialog").evaluate((dialog) => dialog.open);
await page.locator("#folderDialog .folder-cancel").click();
const projectless = await page.evaluate(() => ({
  heading: document.querySelector("#emptyState h1")?.textContent?.trim(),
  sidebar: document.querySelector("#projectName")?.textContent?.trim(),
  path: document.querySelector("#projectPath")?.textContent?.trim(),
  threadPath: document.querySelector("#threadPath")?.textContent?.trim(),
  trigger: document.querySelector("#composerProjectButton")?.textContent?.replace(/\s+/g, " ").trim(),
  dialogOpen: document.querySelector("#folderDialog")?.open,
  mentionMessage: document.querySelector("#composerAutocomplete")?.textContent?.trim(),
}));
await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  (api.mutations.set("active", {
    id: "existing",
    name: "Existing task",
    cwd: `${api.state.config.home}/projects/panda-force`,
    source: "local",
  }),
    api.workbench.threadOpened(api.state.active.id));
  api.renderHeader();
});
const existing = await page.evaluate(() => ({
  triggerHidden: document.querySelector("#composerProjectButton")?.hidden,
  placeholder: document.querySelector("#prompt")?.placeholder,
}));
console.log(
  JSON.stringify(
    { selectedProject, picker, chooseProjectAction, projectPickerReopened, projectless, existing, errors },
    null,
    2,
  ),
);
await browser.close();
{
  qualityAssert.ok(!selectedProject.triggerHidden, "Condition: selectedProject.triggerHidden");
  qualityAssert.ok(
    selectedProject.trigger?.includes(selectedProject.sidebar),
    "Condition: !selectedProject.trigger?.includes(selectedProject.sidebar)",
  );
  qualityAssert.equal(
    selectedProject.heading,
    "What can I help?",
    "Condition: selectedProject.heading!=='What can I help?'",
  );
  qualityAssert.equal(picker.title, "Working folder", "Condition: picker.title!=='Working folder'");
  qualityAssert.ok(picker.projectless?.includes("None"), "Condition: !picker.projectless?.includes('None')");
  qualityAssert.ok(
    picker.projectless?.includes("No working folder"),
    "Condition: !picker.projectless?.includes('No working folder')",
  );
  qualityAssert.equal(projectless.heading, "What can I help?", "Condition: projectless.heading!=='What can I help?'");
  qualityAssert.equal(projectless.sidebar, "Tasks", "Condition: projectless.sidebar!=='Tasks'");
  qualityAssert.equal(projectless.path, "~", "Condition: projectless.path!=='~'");
  qualityAssert.equal(projectless.threadPath, "", "Condition: projectless.threadPath!==''");
  qualityAssert.equal(projectless.trigger, "No working folder", "Condition: projectless.trigger!=='No working folder'");
  qualityAssert.ok(!projectless.dialogOpen, "Condition: projectless.dialogOpen");
  qualityAssert.ok(chooseProjectAction.exists, "Condition: !chooseProjectAction.exists");
  qualityAssert.ok(
    chooseProjectAction.text?.includes("Choose project"),
    "Condition: !chooseProjectAction.text?.includes('Choose project')",
  );
  qualityAssert.ok(projectPickerReopened, "Condition: !projectPickerReopened");
  qualityAssert.ok(existing.triggerHidden, "Condition: !existing.triggerHidden");
  qualityAssert.equal(
    existing.placeholder,
    "Ask for follow-up changes",
    "Condition: existing.placeholder!=='Ask for follow-up changes'",
  );
  qualityAssert.ok(!errors.length, "Condition: errors.length");
}
