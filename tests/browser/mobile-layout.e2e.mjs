import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({
  viewport: { width: 591, height: 1100 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
await page.goto(runtime.base, { waitUntil: "networkidle" });
await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
await page.waitForTimeout(250);
const originalWait = page.waitForFunction.bind(page);
page.waitForFunction = async (...args) => {
  try {
    return await originalWait(...args);
  } catch (error) {
    console.error("Wait failed:", String(args[0]));
    throw error;
  }
};
const box = async (s) =>
  page.locator(s).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      display: getComputedStyle(e).display,
      transform: getComputedStyle(e).transform,
    };
  });
const closedSidebar = await box(".sidebar");
await page.click("#toggleSidebar");
await page.waitForFunction(() => Math.round(document.querySelector(".sidebar").getBoundingClientRect().x) === 0);
const openSidebar = await box(".sidebar");
const sidebarVisibility = await page.evaluate(() => {
  const sidebar = document.querySelector(".sidebar"),
    rect = sidebar.getBoundingClientRect(),
    style = getComputedStyle(sidebar);
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    zIndex: style.zIndex,
    topElement:
      document
        .elementFromPoint(Math.min(rect.right - 10, innerWidth - 10), Math.min(rect.top + 20, innerHeight - 10))
        ?.closest(".sidebar") === sidebar,
  };
});
await page.screenshot({ path: artifact("mobile-sidebar-open.png"), fullPage: false });
const sidebarRows = await page.locator(".sidebar .thread-item").count();
await page.locator(".sidebar .thread-item").first().click();
const sidebarClosedAfterSelection = await page
  .waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().x < 0, { timeout: 3000 })
  .then(() => true)
  .catch(() => false);
if (!sidebarClosedAfterSelection) {
  await page.click("#toggleSidebar");
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().x < 0);
}
const closedSummary = await box("#sessionInspector");
const closedSidePanel = await box("#sidePanel");
await page.click("#sessionInfoButton");
await page.waitForFunction(
  () =>
    document.querySelector("#sessionInspector").open &&
    document.querySelector("#sessionInspector").getBoundingClientRect().width > 0,
);
const openSummary = await box("#sessionInspector");
await page.click('#sessionInspector [data-session-action="close"]');
await page.waitForFunction(
  () => !document.querySelector("#sessionInspector").open && document.activeElement?.id === "sessionInfoButton",
);
await page.click("#sessionInfoButton");
await page.locator('#sessionToolShortcuts [data-session-tool="changes"]').click();
await page.waitForFunction(
  () =>
    !document.querySelector("#sidePanel").hidden &&
    document.querySelector("#sidePanel").getBoundingClientRect().width > 0,
);
const openSidePanel = await box("#sidePanel");
const result = {
  viewport: await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  })),
  app: await box(".app-shell"),
  main: await box(".conversation-shell"),
  closedSidebar,
  openSidebar,
  sidebarVisibility,
  sidebarRows,
  sidebarClosedAfterSelection,
  closedSummary,
  openSummary,
  closedSidePanel,
  openSidePanel,
  topbar: await box(".topbar"),
  composer: await box(".composer"),
};
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: artifact("mobile-layout.png"), fullPage: false });

const narrow = await browser.newPage({
  viewport: { width: 320, height: 800 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
await narrow.goto(runtime.base, { waitUntil: "networkidle" });
await narrow.locator("#workspacePreparation").waitFor({ state: "hidden" });
const narrowChrome = await narrow.evaluate(() => ({
  hasBottomPanelButton: Boolean(document.querySelector("#toggleBottomPanel")),
  hasBottomPanel: Boolean(document.querySelector("#bottomPanel")),
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth,
}));
await narrow.click("#toggleSummaryPanel");
await narrow.waitForFunction(() => document.activeElement?.id === "closeSummaryPanel");
const summaryFocus = await narrow.evaluate(() => ({
  activeId: document.activeElement?.id,
  conversationInert: document.querySelector(".conversation-shell").inert,
}));
await narrow.click("#closeSummaryPanel");
await narrow.waitForFunction(() => document.activeElement?.id === "toggleSummaryPanel");
const summaryRestore = await narrow.evaluate(() => ({
  activeId: document.activeElement?.id,
  conversationInert: document.querySelector(".conversation-shell").inert,
}));
await narrow.click("#toggleSidePanel");
await narrow.waitForFunction(() => document.activeElement?.id === "closeSidePanel");
const sideFocus = await narrow.evaluate(() => ({
  activeId: document.activeElement?.id,
  conversationInert: document.querySelector(".conversation-shell").inert,
}));
await narrow.click('[data-side-panel-action="files"]');
await narrow.locator("#filesDialog").waitFor({ state: "visible" });
await narrow.keyboard.press("Escape");
await narrow.waitForFunction(() => !document.querySelector("#filesDialog").open);
const dialogEscape = await narrow.evaluate(() => ({
  sideOpen: document.body.classList.contains("side-panel-open"),
  activeId: document.activeElement?.id,
}));
await narrow.click("#toggleSidePanel");
await narrow.click("#closeSidePanel");
await narrow.waitForFunction(() => document.activeElement?.id === "toggleSidePanel");
const sideRestore = await narrow.evaluate(() => ({
  activeId: document.activeElement?.id,
  conversationInert: document.querySelector(".conversation-shell").inert,
}));
console.log(
  JSON.stringify(
    { narrow: { narrowChrome, summaryFocus, summaryRestore, sideFocus, dialogEscape, sideRestore } },
    null,
    2,
  ),
);
await browser.close();
{
  qualityAssert.ok(!(result.viewport.scrollWidth > 591), "Condition: result.viewport.scrollWidth>591");
  qualityAssert.ok(!(result.main.x < 0), "Condition: result.main.x<0");
  qualityAssert.ok(!(result.main.width < 560), "Condition: result.main.width<560");
  qualityAssert.equal(result.closedSummary.display, "none", "Condition: result.closedSummary.display!=='none'");
  qualityAssert.equal(result.closedSidePanel.display, "none", "Condition: result.closedSidePanel.display!=='none'");
  qualityAssert.equal(result.openSummary.width, 591, "Condition: result.openSummary.width!==591");
  qualityAssert.equal(result.openSidePanel.width, 591, "Condition: result.openSidePanel.width!==591");
  qualityAssert.ok(!(result.closedSidebar.x >= 0), "Condition: result.closedSidebar.x>=0");
  qualityAssert.ok(!(Math.abs(result.openSidebar.x) > 0.5), "Condition: Math.abs(result.openSidebar.x)>0.5");
  qualityAssert.equal(result.openSidebar.width, 275, "Condition: result.openSidebar.width!==275");
  qualityAssert.ok(
    !(result.sidebarVisibility.display === "none"),
    "Condition: result.sidebarVisibility.display==='none'",
  );
  qualityAssert.equal(
    result.sidebarVisibility.visibility,
    "visible",
    "Condition: result.sidebarVisibility.visibility!=='visible'",
  );
  qualityAssert.ok(!(result.sidebarVisibility.opacity === "0"), "Condition: result.sidebarVisibility.opacity==='0'");
  qualityAssert.ok(result.sidebarVisibility.topElement, "Condition: !result.sidebarVisibility.topElement");
  qualityAssert.ok(!(result.sidebarRows < 1), "Condition: result.sidebarRows<1");
  qualityAssert.ok(result.sidebarClosedAfterSelection, "Condition: !result.sidebarClosedAfterSelection");
  qualityAssert.ok(!narrowChrome.hasBottomPanelButton, "Condition: narrowChrome.hasBottomPanelButton");
  qualityAssert.ok(!narrowChrome.hasBottomPanel, "Condition: narrowChrome.hasBottomPanel");
  qualityAssert.ok(
    !(narrowChrome.scrollWidth > narrowChrome.innerWidth),
    "Condition: narrowChrome.scrollWidth>narrowChrome.innerWidth",
  );
  qualityAssert.equal(
    summaryFocus.activeId,
    "closeSummaryPanel",
    "Condition: summaryFocus.activeId!=='closeSummaryPanel'",
  );
  qualityAssert.ok(summaryFocus.conversationInert, "Condition: !summaryFocus.conversationInert");
  qualityAssert.equal(
    summaryRestore.activeId,
    "toggleSummaryPanel",
    "Condition: summaryRestore.activeId!=='toggleSummaryPanel'",
  );
  qualityAssert.ok(!summaryRestore.conversationInert, "Condition: summaryRestore.conversationInert");
  qualityAssert.equal(sideFocus.activeId, "closeSidePanel", "Condition: sideFocus.activeId!=='closeSidePanel'");
  qualityAssert.ok(sideFocus.conversationInert, "Condition: !sideFocus.conversationInert");
  qualityAssert.ok(!dialogEscape.sideOpen, "Condition: dialogEscape.sideOpen");
  qualityAssert.equal(sideRestore.activeId, "toggleSidePanel", "Condition: sideRestore.activeId!=='toggleSidePanel'");
  qualityAssert.ok(!sideRestore.conversationInert, "Condition: sideRestore.conversationInert");
}
