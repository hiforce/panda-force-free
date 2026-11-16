/** Browser entry point. Feature composition and startup live in application.js. */
import { startApplication } from "./application.js";

if (globalThis.__pandaForceIdentity?.role === "member") {
  document.body.classList.add("local-member");
  for (const selector of [
    "#newTask",
    "#searchThreads",
    "#threadList",
    "#accountButton",
    "#toggleFilesPanel",
    "#toggleSidePanel",
    "#toggleSummaryPanel",
    "#terminalPanel",
  ]) {
    const control = document.querySelector(selector);
    if (control instanceof HTMLElement) control.hidden = true;
  }
  if (["/", "/workspace", "/tasks", "/new"].includes(location.pathname)) history.replaceState({}, "", "/create");
}
startApplication();
