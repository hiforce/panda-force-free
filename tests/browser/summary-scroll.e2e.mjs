import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const browser = await runtime.launchBrowser(launchOptions());
const page = await browser.newPage({ viewport: { width: 591, height: 360 }, isMobile: true, hasTouch: true });
await page.goto(runtime.base + "/new", { waitUntil: "networkidle" });
await page.click("#toggleSummaryPanel");
await page.waitForFunction(() => document.activeElement?.id === "closeSummaryPanel");
const result = await page.evaluate(() => {
  const panel = document.querySelector("#summaryPanel");
  const toolbar = document.querySelector(".summary-panel-toolbar");
  const scroller = document.querySelector(".summary-panel-scroll");
  scroller.scrollTop = scroller.scrollHeight;
  const source = [...document.querySelectorAll(".summary-section-title")].find(
    (node) => node.textContent.trim() === "Sources",
  );
  const panelRect = panel.getBoundingClientRect(),
    toolbarRect = toolbar.getBoundingClientRect(),
    scrollRect = scroller.getBoundingClientRect(),
    sourceRect = source.getBoundingClientRect();
  return {
    panelHeight: panelRect.height,
    toolbarHeight: toolbarRect.height,
    scrollHeight: scrollRect.height,
    total: toolbarRect.height + scrollRect.height,
    sourceBottom: sourceRect.bottom,
    panelBottom: panelRect.bottom,
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
{
  qualityAssert.ok(!(result.total > result.panelHeight + 0.5), "Condition: result.total>result.panelHeight+.5");
  qualityAssert.ok(
    !(result.sourceBottom > result.panelBottom + 0.5),
    "Condition: result.sourceBottom>result.panelBottom+.5",
  );
}
