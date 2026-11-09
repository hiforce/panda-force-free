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
await page.waitForFunction(
  () =>
    document.querySelector("#modelLabel")?.textContent?.trim() &&
    !/loading/i.test(document.querySelector("#modelLabel").textContent),
);
const modelFilter = await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  const mixed = [
    ...api.state.models,
    { model: "o3", displayName: "o3" },
    { model: "glm-5.3-flash", displayName: "GLM 5.3 Flash" },
  ];
  api.mutations.set("models", api.filterAppModels(mixed));
  api.renderModels();
  return {
    models: api.state.models.map((model) => model.model),
    hasO3: api.state.models.some((model) => model.model === "o3"),
    hasGlm: api.state.models.some((model) => model.model === "glm-5.3-flash"),
  };
});
const home = await page.evaluate(() => {
  const composer = document.querySelector(".composer");
  const send = document.querySelector("#sendButton");
  const trigger = document.querySelector("#modelButton");
  const style = (node) => {
    const s = getComputedStyle(node),
      r = node.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      borderRadius: s.borderRadius,
      background: s.backgroundColor,
      border: s.borderTopWidth,
      display: s.display,
    };
  };
  return {
    heading: document.querySelector(".empty-state h1")?.textContent?.trim(),
    placeholder: document.querySelector("#prompt")?.placeholder,
    fixedContextVisible: Boolean(
      document.querySelector(".composer-context") &&
      document.querySelector(".composer-context").getBoundingClientRect().height > 1,
    ),
    contextTrayHidden: document.querySelector("#composerContextTray")?.hidden,
    controls: [...document.querySelectorAll(".composer-footer [data-composer-control]")].map(
      (node) => node.dataset.composerControl,
    ),
    composer: style(composer),
    send: style(send),
    trigger: style(trigger),
    triggerText: trigger?.textContent?.replace(/\s+/g, " ").trim(),
    accessibleName: trigger?.getAttribute("aria-label"),
    iconWidth: document.querySelector(".composer-model-icon")?.getBoundingClientRect().width,
    nativeTrigger: trigger?.hasAttribute("data-codex-intelligence-trigger"),
  };
});
const contextUsage = await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug,
    initiallyHidden = document.querySelector("#contextUsage").hidden;
  (api.mutations.set("active", { id: "context-thread", cwd: api.state.config.defaultCwd }),
    api.workbench.threadOpened(api.state.active.id));
  api.notify("thread/tokenUsage/updated", {
    threadId: "context-thread",
    tokenUsage: { modelContextWindow: 200000, last: { totalTokens: 80000 } },
  });
  const indicator = document.querySelector("#contextUsage"),
    progress = indicator.querySelector(".context-usage-progress"),
    queue = document.querySelector('[data-composer-control="queue"]');
  return {
    initiallyHidden,
    hidden: indicator.hidden,
    ariaLabel: indicator.getAttribute("aria-label"),
    tooltip: indicator.dataset.tooltip,
    dashOffset: getComputedStyle(progress).strokeDashoffset,
    inComposerRight: indicator.parentElement?.classList.contains("composer-right"),
    beforeQueue: Boolean(indicator.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});
// The new-session composer retains the immediate picker; active sessions use Save/Cancel sheets.
await page.click("#newTask");
await page.click("#modelButton");
await page.screenshot({ path: artifact("composer-model-menu.png"), fullPage: false });
const modelMain = await page.evaluate(() => ({
  open: !document.querySelector("#modelMenu").hidden,
  title: document.querySelector("#modelMenu .model-menu-title")?.textContent?.trim(),
  effortRows: [...document.querySelectorAll("#modelMenu .model-effort-row")].map((node) => node.textContent.trim()),
  modelRow: document.querySelector("#modelSubmenuButton")?.textContent?.replace(/\s+/g, " ").trim(),
  directModelRows: document.querySelectorAll("#modelMenu>.model-option").length,
  width: document.querySelector("#modelMenu").getBoundingClientRect().width,
}));
await page.click('#modelMenu .model-effort-row[data-value="high"]');
const effortSelection = await page.evaluate(() => ({
  menuHidden: document.querySelector("#modelMenu").hidden,
  label: document.querySelector("#effortLabel").textContent.trim(),
}));
await page.click("#modelButton");
await page.click("#modelSubmenuButton");
const modelSubmenu = await page.evaluate(() => ({
  title: document.querySelector("#modelMenu .model-menu-title")?.textContent?.trim(),
  rows: [...document.querySelectorAll("#modelMenu .model-option")].map((node) =>
    node.textContent.replace(/\s+/g, " ").trim(),
  ),
  back: Boolean(document.querySelector("#modelMenuBack")),
}));
await page.click('#modelMenu .model-option[data-model="gpt-5.6-luna"]');
await page.click("#modelButton");
const lunaEfforts = await page.locator("#modelMenu .model-effort-row").allTextContents();
await page.click("#modelSubmenuButton");
await page.click('#modelMenu .model-option[data-model="gpt-5.6-sol"]');
await page.click("#modelButton");
const solEfforts = await page.locator("#modelMenu .model-effort-row").allTextContents();
await page.keyboard.press("Escape");
await page.screenshot({ path: artifact("composer-native.png"), fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
const mobileModel = await page.evaluate(() => {
  const label = document.querySelector("#modelLabel"),
    trigger = document.querySelector("#modelButton"),
    rect = label?.getBoundingClientRect();
  return {
    label: label?.textContent?.trim(),
    labelDisplay: label ? getComputedStyle(label).display : null,
    labelWidth: rect?.width ?? 0,
    accessibleName: trigger?.getAttribute("aria-label"),
    iconWidth: document.querySelector(".composer-model-icon")?.getBoundingClientRect().width,
    triggerText: trigger?.textContent?.replace(/\s+/g, " ").trim(),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  };
});
console.log(
  JSON.stringify(
    {
      home,
      contextUsage,
      modelFilter,
      modelMain,
      effortSelection,
      modelSubmenu,
      lunaEfforts,
      solEfforts,
      mobileModel,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
const expected = ["add", "approval", "model", "queue", "send"];
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(home.heading, "What can I help?", "Condition: home.heading!=='What can I help?'");
  qualityAssert.equal(
    home.placeholder,
    "Describe a task, add files, or start with an idea…",
    "Condition: home.placeholder!=='Describe a task, add files, or start with an idea…'",
  );
  qualityAssert.ok(!home.fixedContextVisible, "Condition: home.fixedContextVisible");
  qualityAssert.equal(home.contextTrayHidden, true, "Condition: home.contextTrayHidden!==true");
  qualityAssert.equal(
    JSON.stringify(home.controls),
    JSON.stringify(expected),
    "Condition: JSON.stringify(home.controls)!==JSON.stringify(expected)",
  );
  qualityAssert.ok(home.nativeTrigger, "Condition: !home.nativeTrigger");
  qualityAssert.ok(contextUsage.initiallyHidden, "Condition: !contextUsage.initiallyHidden");
  qualityAssert.ok(!contextUsage.hidden, "Condition: contextUsage.hidden");
  qualityAssert.equal(
    contextUsage.ariaLabel,
    "Context usage: 40%",
    "Condition: contextUsage.ariaLabel!=='Context usage: 40%'",
  );
  qualityAssert.equal(
    contextUsage.tooltip,
    "Context window:\n40% used (60% left)\n80k / 200k tokens used",
    "Condition: contextUsage.tooltip!=='Context window:\\n40% used (60% left)\\n80k / 200k tokens used'",
  );
  qualityAssert.ok(
    !(Math.abs(parseFloat(contextUsage.dashOffset) - 60) > 0.1),
    "Condition: Math.abs(parseFloat(contextUsage.dashOffset)-60)>.1",
  );
  qualityAssert.ok(contextUsage.inComposerRight, "Condition: !contextUsage.inComposerRight");
  qualityAssert.ok(contextUsage.beforeQueue, "Condition: !contextUsage.beforeQueue");
  qualityAssert.ok(!/^GPT-/i.test(home.triggerText || ""), "Condition: /^GPT-/i.test(home.triggerText||'')");
  qualityAssert.ok(modelFilter.hasO3, "The model picker preserves provider models without a GPT prefix");
  qualityAssert.ok(modelFilter.hasGlm, "The model picker includes configured GLM models");
  qualityAssert.equal(home.trigger.border, "1px", "Desktop model settings keep a complete dropdown field");
  qualityAssert.equal(home.iconWidth, 0, "Desktop fields retain their complete text labels");
  qualityAssert.equal(modelMain.title, "Reasoning", "Condition: modelMain.title!=='Reasoning'");
  qualityAssert.ok(!(modelMain.effortRows.length < 1), "Condition: modelMain.effortRows.length<1");
  qualityAssert.ok(/Model/i.test(modelMain.modelRow || ""), "Condition: !/Model/i.test(modelMain.modelRow||'')");
  qualityAssert.equal(modelMain.directModelRows, 0, "Condition: modelMain.directModelRows!==0");
  qualityAssert.ok(!(modelMain.width < 210), "Condition: modelMain.width<210");
  qualityAssert.ok(!(modelMain.width > 250), "Condition: modelMain.width>250");
  qualityAssert.ok(effortSelection.menuHidden, "Condition: !effortSelection.menuHidden");
  qualityAssert.equal(effortSelection.label, "High", "Condition: effortSelection.label!=='High'");
  qualityAssert.equal(modelSubmenu.title, "Model", "Condition: modelSubmenu.title!=='Model'");
  qualityAssert.ok(!(modelSubmenu.rows.length < 1), "Condition: modelSubmenu.rows.length<1");
  qualityAssert.ok(modelSubmenu.back, "Condition: !modelSubmenu.back");
  qualityAssert.ok(!modelMain.effortRows.includes("Light"), "Condition: modelMain.effortRows.includes('Light')");
  qualityAssert.ok(!lunaEfforts.includes("Light"), "Condition: lunaEfforts.includes('Light')");
  qualityAssert.ok(!solEfforts.includes("Light"), "Condition: solEfforts.includes('Light')");
  qualityAssert.ok(!lunaEfforts.includes("Ultra"), "Condition: lunaEfforts.includes('Ultra')");
  qualityAssert.ok(lunaEfforts.includes("High"), "Condition: !lunaEfforts.includes('High')");
  qualityAssert.ok(solEfforts.includes("Extra High"), "Condition: !solEfforts.includes('Extra High')");
  qualityAssert.ok(mobileModel.label, "Condition: !mobileModel.label");
  qualityAssert.equal(mobileModel.labelDisplay, "none", "Mobile model settings use an icon button");
  qualityAssert.equal(mobileModel.labelWidth, 0);
  qualityAssert.ok(mobileModel.iconWidth >= 18);
  qualityAssert.ok(mobileModel.accessibleName?.includes(mobileModel.label));
  qualityAssert.ok(
    mobileModel.triggerText?.includes(mobileModel.label),
    "Condition: !mobileModel.triggerText?.includes(mobileModel.label)",
  );
  qualityAssert.ok(!mobileModel.horizontalOverflow, "Condition: mobileModel.horizontalOverflow");
  qualityAssert.ok(
    !(parseFloat(home.composer.borderRadius) < 12),
    "Condition: parseFloat(home.composer.borderRadius)<12",
  );
  qualityAssert.ok(
    !(Math.abs(home.send.width - home.send.height) > 0.5),
    "Condition: Math.abs(home.send.width-home.send.height)>.5",
  );
}
