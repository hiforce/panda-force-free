import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";
import { devices } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const browser = await runtime.launchBrowser(launchOptions());
const context = await browser.newContext({
  ...devices["Pixel 7"],
  viewport: { width: 980, height: 1800 },
  screen: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
await page.goto(runtime.base, { waitUntil: "networkidle" });
await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
await page.waitForTimeout(250);
const before = await page.evaluate(() => ({
  innerWidth,
  coarse: matchMedia("(pointer: coarse)").matches,
  mobileClass: document.documentElement.classList.contains("mobile-device"),
  sidebarX: document.querySelector("#sidebar").getBoundingClientRect().x,
  sidebarPosition: getComputedStyle(document.querySelector("#sidebar")).position,
  sidebarShadow: getComputedStyle(document.querySelector("#sidebar")).boxShadow,
}));
// A touch-capable tablet follows the desktop breakpoint, rather than the pointer type.
await assertTabletDesktop();
async function assertTabletDesktop() {
  qualityAssert.equal(before.sidebarPosition, "static");
  qualityAssert.ok(Math.abs(before.sidebarX) < 1);
  await page.click("#toggleSidebar");
  await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
  await page.click("#workspaceNavigationToggle");
}
await page.waitForFunction(
  () => Math.abs(document.querySelector("#sidebar").getBoundingClientRect().width - 232) < 0.01,
);
const after = await page.evaluate(() => {
  const sidebar = document.querySelector("#sidebar"),
    rect = sidebar.getBoundingClientRect();
  return {
    x: rect.x,
    right: rect.right,
    width: rect.width,
    mobileOpen: sidebar.classList.contains("mobile-open"),
    bodyHidden: document.body.classList.contains("sidebar-hidden"),
    position: getComputedStyle(sidebar).position,
    shadow: getComputedStyle(sidebar).boxShadow,
    topElement:
      document
        .elementFromPoint(Math.min(rect.right - 10, innerWidth - 10), Math.min(rect.top + 20, innerHeight - 10))
        ?.closest("#sidebar") === sidebar,
  };
});
await page.screenshot({ path: artifact("mobile-device-sidebar.png"), fullPage: false });
console.log(JSON.stringify({ before, after }, null, 2));
await browser.close();
{
  qualityAssert.ok(before.coarse, "Condition: !before.coarse");
  qualityAssert.ok(before.mobileClass, "Condition: !before.mobileClass");
  qualityAssert.equal(after.position, "static");
  qualityAssert.equal(after.mobileOpen, false);
  qualityAssert.equal(after.bodyHidden, false);
  qualityAssert.ok(Math.abs(after.x) < 0.5);
  qualityAssert.ok(Math.abs(after.width - 232) < 0.01);
  qualityAssert.equal(after.shadow, "none");
  qualityAssert.ok(after.topElement, "Condition: !after.topElement");
}
