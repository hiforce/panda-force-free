import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 1018, height: 980 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(runtime.base, { waitUntil: "networkidle" });
await page.waitForFunction(() => globalThis.__pandaForceDebug?.state?.config?.defaultCwd);
await page.click("#newTask");

await page.locator("#prompt").fill("/");
await page.waitForSelector("#composerAutocomplete:not([hidden])");
await page.screenshot({ path: artifact("composer-slash-menu.png"), fullPage: false });
const slash = await page.evaluate(() => ({
  type: document.querySelector("#composerAutocomplete").dataset.type,
  label: document.querySelector("#composerAutocomplete").getAttribute("aria-label"),
  items: [...document.querySelectorAll("#composerAutocomplete [data-autocomplete-id]")].map((node) => ({
    id: node.dataset.autocompleteId,
    title: node.querySelector(".autocomplete-title")?.textContent?.trim(),
    description: node.querySelector(".autocomplete-description")?.textContent?.trim(),
  })),
  above:
    document.querySelector("#composerAutocomplete").getBoundingClientRect().bottom <=
    document.querySelector(".composer").getBoundingClientRect().top + 1,
  onscreen: document.querySelector("#composerAutocomplete").getBoundingClientRect().top >= 46,
  topmost: (() => {
    const rect = document.querySelector("#composerAutocomplete").getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.left + 12, rect.top + 12)?.closest("#composerAutocomplete"));
  })(),
}));
await page.locator("#prompt").fill("/pla");
const filtered = await page.locator("#composerAutocomplete [data-autocomplete-id]").allTextContents();
await page.keyboard.press("Enter");
const plan = await page.evaluate(() => ({
  active: globalThis.__pandaForceDebug.state.planMode,
  placeholder: document.querySelector("#prompt").placeholder,
  value: document.querySelector("#prompt").value,
  menuHidden: document.querySelector("#composerAutocomplete").hidden,
  approval: document.querySelector("#modeButton .control-label").textContent.trim(),
}));

await page.locator("#prompt").fill("/model");
await page.keyboard.press("Enter");
const modelCommand = await page.evaluate(() => ({
  autocompleteHidden: document.querySelector("#composerAutocomplete").hidden,
  modelOpen: !document.querySelector("#modelMenu").hidden,
  modelTitle: document.querySelector("#modelMenu .model-menu-title")?.textContent?.trim(),
}));
await page.keyboard.press("Escape");

await page.locator("#prompt").fill("@");
const mentionEmpty = await page.evaluate(() => ({
  type: document.querySelector("#composerAutocomplete").dataset.type,
  text: document.querySelector("#composerAutocomplete").textContent.trim(),
  label: document.querySelector("#composerAutocomplete").getAttribute("aria-label"),
}));
await page.locator("#prompt").fill("@package");
await page.waitForFunction(() =>
  [...document.querySelectorAll("#composerAutocomplete [data-autocomplete-id]")].some(
    (node) => node.dataset.autocompleteId === "file:package.json",
  ),
);
await page.screenshot({ path: artifact("composer-mention-menu.png"), fullPage: false });
const mentionResults = await page.evaluate(() => {
  const menu = document.querySelector("#composerAutocomplete"),
    rect = menu.getBoundingClientRect();
  return {
    items: [...menu.querySelectorAll("[data-autocomplete-id]")].map((node) => ({
      id: node.dataset.autocompleteId,
      title: node.querySelector(".autocomplete-title")?.textContent?.trim(),
      description: node.querySelector(".autocomplete-description")?.textContent?.trim(),
    })),
    onscreen: rect.top >= 46,
    topmost: Boolean(document.elementFromPoint(rect.left + 12, rect.top + 12)?.closest("#composerAutocomplete")),
  };
});
await page.keyboard.press("Enter");
const mentionSelected = await page.evaluate(() => ({
  value: document.querySelector("#prompt").value,
  menuHidden: document.querySelector("#composerAutocomplete").hidden,
  trayHidden: document.querySelector("#composerContextTray").hidden,
  chips: [...document.querySelectorAll("#composerContextTray .composer-context-chip")].map((node) =>
    node.textContent.trim(),
  ),
}));
await page.click("#newTask");
const reset = await page.evaluate(() => ({
  value: document.querySelector("#prompt").value,
  trayHidden: document.querySelector("#composerContextTray").hidden,
  chips: document.querySelectorAll("#composerContextTray .composer-context-chip").length,
}));
const mobile = await browser.newPage({ viewport: { width: 360, height: 780 }, colorScheme: "dark" });
await mobile.goto(runtime.base, { waitUntil: "networkidle" });
await mobile.locator("#prompt").fill("/");
await mobile.waitForSelector("#composerAutocomplete:not([hidden])");
const mobileLayout = await mobile.evaluate(() => {
  const menu = document.querySelector("#composerAutocomplete").getBoundingClientRect(),
    composer = document.querySelector(".composer").getBoundingClientRect();
  return {
    left: menu.left,
    right: menu.right,
    top: menu.top,
    bottom: menu.bottom,
    composerTop: composer.top,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
  };
});
await mobile.close();
console.log(
  JSON.stringify(
    { slash, filtered, plan, modelCommand, mentionEmpty, mentionResults, mentionSelected, reset, mobileLayout, errors },
    null,
    2,
  ),
);
await browser.close();

const ids = slash.items.map((item) => item.id);
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(slash.type, "slash", "Condition: slash.type!=='slash'");
  qualityAssert.equal(slash.label, "Slash command menu", "Condition: slash.label!=='Slash command menu'");
  qualityAssert.ok(slash.above, "Condition: !slash.above");
  qualityAssert.ok(slash.onscreen, "Condition: !slash.onscreen");
  qualityAssert.ok(slash.topmost, "Condition: !slash.topmost");
  qualityAssert.ok(
    ["model", "plan", "project", "reasoning", "init", "mcp"].every((id) => ids.includes(id)),
    "Condition: !['model','plan','project','reasoning','init','mcp'].every(id=>ids.includes(id))",
  );
  qualityAssert.ok(
    !slash.items.some((item) => !item.title || !item.description),
    "Condition: slash.items.some(item=>!item.title||!item.description)",
  );
  qualityAssert.equal(filtered.length, 1, "Condition: filtered.length!==1");
  qualityAssert.ok(/Plan mode/i.test(filtered[0]), "Condition: !/Plan mode/i.test(filtered[0])");
  qualityAssert.ok(plan.active, "Condition: !plan.active");
  qualityAssert.equal(
    plan.placeholder,
    "Describe a task, add files, or start with an idea…",
    "Condition: plan.placeholder!=='Describe a task, add files, or start with an idea…'",
  );
  qualityAssert.equal(plan.value, "", "Condition: plan.value!==''");
  qualityAssert.ok(plan.menuHidden, "Condition: !plan.menuHidden");
  qualityAssert.equal(plan.approval, "Plan mode", "Condition: plan.approval!=='Plan mode'");
  qualityAssert.ok(modelCommand.autocompleteHidden, "Condition: !modelCommand.autocompleteHidden");
  qualityAssert.ok(modelCommand.modelOpen, "Condition: !modelCommand.modelOpen");
  qualityAssert.equal(modelCommand.modelTitle, "Reasoning", "Condition: modelCommand.modelTitle!=='Reasoning'");
  qualityAssert.equal(mentionEmpty.type, "mention", "Condition: mentionEmpty.type!=='mention'");
  qualityAssert.equal(mentionEmpty.label, "Mention menu", "Condition: mentionEmpty.label!=='Mention menu'");
  qualityAssert.ok(
    /Type to search for files/i.test(mentionEmpty.text),
    "Condition: !/Type to search for files/i.test(mentionEmpty.text)",
  );
  qualityAssert.ok(mentionResults.onscreen, "Condition: !mentionResults.onscreen");
  qualityAssert.ok(mentionResults.topmost, "Condition: !mentionResults.topmost");
  qualityAssert.ok(
    mentionResults.items.some((item) => item.id === "file:package.json" && item.title === "package.json"),
    "Condition: !mentionResults.items.some(item=>item.id==='file:package.json'&&item.title==='package.json')",
  );
  qualityAssert.equal(mentionSelected.value, "@package.json ", "Condition: mentionSelected.value!=='@package.json '");
  qualityAssert.ok(mentionSelected.menuHidden, "Condition: !mentionSelected.menuHidden");
  qualityAssert.ok(!mentionSelected.trayHidden, "Condition: mentionSelected.trayHidden");
  qualityAssert.ok(
    mentionSelected.chips.includes("package.json"),
    "Condition: !mentionSelected.chips.includes('package.json')",
  );
  qualityAssert.equal(reset.value, "@package.json ", "Condition: reset.value!=='@package.json '");
  qualityAssert.ok(!reset.trayHidden, "Condition: reset.trayHidden");
  qualityAssert.equal(reset.chips, 1, "Condition: reset.chips!==1");
  qualityAssert.ok(!(mobileLayout.left < 0), "Condition: mobileLayout.left<0");
  qualityAssert.ok(
    !(mobileLayout.right > mobileLayout.innerWidth),
    "Condition: mobileLayout.right>mobileLayout.innerWidth",
  );
  qualityAssert.ok(!(mobileLayout.top < 46), "Condition: mobileLayout.top<46");
  qualityAssert.ok(
    !(mobileLayout.bottom > mobileLayout.composerTop),
    "Condition: mobileLayout.bottom>mobileLayout.composerTop",
  );
  qualityAssert.ok(
    !(mobileLayout.scrollWidth > mobileLayout.innerWidth),
    "Condition: mobileLayout.scrollWidth>mobileLayout.innerWidth",
  );
}
