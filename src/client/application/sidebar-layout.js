// Owns sidebar layout, mobile visibility and help/search affordances.
export function assembleSidebarLayout({ viewUpdates, $, noticesPort, t, settingsPort }) {
  let sidebarLayoutMobile = null;
  function setSidebarOpen(open) {
    const sidebar = $("#sidebar"),
      mobile = mobileSidebarEnabled();
    document.body.classList.toggle("sidebar-hidden", !mobile && !open);
    sidebar.classList.toggle("mobile-open", mobile && open);
    const visible = mobile
      ? sidebar.classList.contains("mobile-open")
      : !document.body.classList.contains("sidebar-hidden");
    $("#toggleSidebar").setAttribute("aria-expanded", String(visible));
    $("#toggleSidebar").setAttribute("aria-pressed", String(visible));
  }
  function syncSidebarLayout() {
    const mobile = mobileSidebarEnabled();
    if (mobile === sidebarLayoutMobile) return;
    sidebarLayoutMobile = mobile;
    setSidebarOpen(!mobile);
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
    return document.documentElement.classList.contains("mobile-device") || innerWidth < 720;
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
    $("#toggleSidebar").onclick = () =>
      setSidebarOpen(
        mobileSidebarEnabled()
          ? !$("#sidebar").classList.contains("mobile-open")
          : document.body.classList.contains("sidebar-hidden"),
      );
  }
  return {
    bind,
    mobileSidebarEnabled,
    setSidebarOpen,
    syncSidebarLayout,
    setSidebarSearchOpen,
    setSidebarHelpOpen,
  };
}
