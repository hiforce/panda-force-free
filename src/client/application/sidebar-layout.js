import { storage, STORAGE_KEYS } from "../storage.js";
import { codexIcon } from "../codex-icons.js";
import { setMessageHtml } from "../i18n.js";
// Owns sidebar layout, mobile visibility and help/search affordances.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "$" | "t", "notices" | "settings", "sidebarLayout">} options */
export function assembleSidebarLayout({ viewUpdates, $, noticesPort, t, settingsPort }) {
  let sidebarLayoutMobile = null;
  function isSidebarOpen() {
    return mobileSidebarEnabled()
      ? $("#sidebar").classList.contains("mobile-open")
      : !document.body.classList.contains("sidebar-hidden");
  }
  function setSidebarOpen(open, { temporary = false } = {}) {
    const sidebar = $("#sidebar"),
      mobile = mobileSidebarEnabled();
    document.body.classList.toggle("sidebar-hidden", !mobile && !open);
    sidebar.classList.toggle("mobile-open", mobile && open);
    const visible = mobile
      ? sidebar.classList.contains("mobile-open")
      : !document.body.classList.contains("sidebar-hidden");
    if (!mobile && !temporary) storage.set(STORAGE_KEYS.sidebarOpen, String(open));
    for (const selector of ["#toggleSidebar", "#workspaceNavigationToggle"]) {
      $(selector).setAttribute("aria-expanded", String(visible));
      $(selector).setAttribute("aria-pressed", String(visible));
    }
  }
  function syncSidebarLayout() {
    const mobile = mobileSidebarEnabled();
    if (mobile === sidebarLayoutMobile) return;
    sidebarLayoutMobile = mobile;
    setMessageHtml($("#toggleSidebar"), codexIcon(mobile ? "menu" : "panelLeft"));
    setMessageHtml($("#workspaceNavigationToggle"), codexIcon(mobile ? "menu" : "panelLeft"));
    setSidebarOpen(!mobile && storage.get(STORAGE_KEYS.sidebarOpen) !== "false", { temporary: true });
  }
  function setSidebarSearchOpen(open) {
    const panel = $("#sidebarSearchPanel"),
      input = $("#threadSearch");
    panel.hidden = !open;
    $("#sidebarSearchButton").setAttribute("aria-expanded", String(open));
    if (open) {
      requestAnimationFrame(() => input.focus());
      return;
    }
    if (input.value) {
      input.value = "";
      viewUpdates.request("sidebar");
    }
  }
  function setSidebarHelpOpen(open) {
    $("#sidebarHelpMenu").hidden = !open;
    $("#sidebarHelpButton").setAttribute("aria-expanded", String(open));
  }
  function mobileSidebarEnabled() {
    return innerWidth < 768;
  }
  function bind() {
    $("#productModeButton").onclick = () => noticesPort.toast(t("common.currentEngineCodex"));
    $("#sidebarSearchButton").onclick = (event) => {
      event.stopPropagation();
      setSidebarSearchOpen($("#sidebarSearchPanel").hidden);
    };
    $("#sidebarSearchClose").onclick = () => setSidebarSearchOpen(false);
    $("#sidebarHelpButton").onclick = (event) => {
      event.stopPropagation();
      setSidebarHelpOpen($("#sidebarHelpMenu").hidden);
    };
    $("#sidebarHelpSettings").onclick = () => {
      setSidebarHelpOpen(false);
      settingsPort.openSettings("general-settings");
    };
    $("#sidebarHelpShortcuts").onclick = () => {
      setSidebarHelpOpen(false);
      settingsPort.openSettings("keyboard-shortcuts");
    };
    $("#workspaceNavigationToggle").onclick = () => $("#toggleSidebar").click();
    $("#toggleSidebar").onclick = () =>
      setSidebarOpen(
        mobileSidebarEnabled()
          ? !$("#sidebar").classList.contains("mobile-open")
          : document.body.classList.contains("sidebar-hidden"),
      );
  }
  return {
    bind,
    isSidebarOpen,
    mobileSidebarEnabled,
    setSidebarOpen,
    syncSidebarLayout,
    setSidebarSearchOpen,
    setSidebarHelpOpen,
  };
}
