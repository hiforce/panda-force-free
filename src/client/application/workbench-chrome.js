import { createWorkbenchChrome } from "../workbench-chrome/controller.js";

/** Global chrome coordinates feature ports without owning or mutating session state. */
/** @param {import("./ports.js").FeatureOptions<"t" | "i18n", "workbench" | "settings" | "sidebarLayout" | "sessionWorkspace" | "notices", "workbenchChrome">} options */
export function assembleWorkbenchChrome({
  t,
  i18n,
  workbenchPort,
  settingsPort,
  sidebarLayoutPort,
  sessionWorkspacePort,
  noticesPort,
}) {
  const chrome = createWorkbenchChrome({
    t,
    i18n,
    openSearch: () => workbenchPort.workbench.openSearch(),
    openSettings: (page) => settingsPort.openSettings(page),
    readSidebar: () => sidebarLayoutPort.isSidebarOpen(),
    setSidebar: (open, settings) => sidebarLayoutPort.setSidebarOpen(open, settings),
    readDetails: () => sessionWorkspacePort.isOpen(),
    setDetails: (open, settings) => sessionWorkspacePort.setOpen(open, settings),
    hasSession: () => document.body.classList.contains("session-layout"),
    onError: (message) => noticesPort.toast(message),
  });
  return { bind: chrome.bind };
}
