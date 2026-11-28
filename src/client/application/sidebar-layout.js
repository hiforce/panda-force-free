import { storage, STORAGE_KEYS } from "../storage.js";
import { codexIcon } from "../codex-icons.js";
import { setMessageHtml } from "../i18n.js";
// Owns sidebar layout, mobile visibility and help/search affordances.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "$" | "t", "notices" | "settings", "sidebarLayout">} options */
export function assembleSidebarLayout({ viewUpdates, $, noticesPort, t, settingsPort }) {
  let sidebarLayoutMobile = null;
  /** @type {"menu" | "sessions"} */
  let sidebarTab = "menu";
  const scrollPositions = { menu: 0, sessions: 0 };
  /** @param {"menu" | "sessions"} tab */
  function panel(tab) {
    return tab === "menu" ? $("#sidebarMenuPanel") : $("#sidebarSessionsPanel");
  }
  function syncSidebarSections() {
    $("#sidebarSectionTabs").hidden = false;
    $("#sidebar").dataset.sidebarTab = sidebarTab;
    for (const name of /** @type {Array<"menu" | "sessions">} */ (["menu", "sessions"])) {
      const tab = name === "menu" ? $("#sidebarMenuTab") : $("#sidebarSessionsTab"),
        content = panel(name);
      tab.setAttribute("aria-selected", String(name === sidebarTab));
      tab.tabIndex = name === sidebarTab ? 0 : -1;
      content.hidden = name !== sidebarTab;
      content.setAttribute("role", "tabpanel");
      content.setAttribute("aria-labelledby", tab.id);
    }
  }
  /** @param {"menu" | "sessions"} next */
  function selectSidebarTab(next, { focus = false } = {}) {
    const changed = sidebarTab !== next;
    if (changed) scrollPositions[sidebarTab] = panel(sidebarTab).scrollTop;
    sidebarTab = next;
    syncSidebarSections();
    if (changed) panel(next).scrollTop = scrollPositions[next];
    if (focus) (next === "menu" ? $("#sidebarMenuTab") : $("#sidebarSessionsTab")).focus({ preventScroll: true });
  }
  function isSidebarOpen() {
    return mobileSidebarEnabled()
      ? $("#sidebar").classList.contains("mobile-open")
      : !document.body.classList.contains("sidebar-hidden");
  }
  function setSidebarOpen(open, { temporary = false } = {}) {
    const sidebar = $("#sidebar"),
      mobile = mobileSidebarEnabled(),
      wasOpen = isSidebarOpen();
    if (!open && wasOpen) scrollPositions[sidebarTab] = panel(sidebarTab).scrollTop;
    document.body.classList.toggle("sidebar-hidden", !mobile && !open);
    sidebar.classList.toggle("mobile-open", mobile && open);
    if (open && !wasOpen) {
      scrollPositions.menu = 0;
      selectSidebarTab("menu", { focus: !temporary });
      panel("menu").scrollTop = 0;
    } else if (!open && sidebar.contains(document.activeElement))
      $("#workspaceNavigationToggle").focus({ preventScroll: true });
    const visible = mobile
      ? sidebar.classList.contains("mobile-open")
      : !document.body.classList.contains("sidebar-hidden");
    if (!mobile && !temporary && !document.body.classList.contains("document-navigation-focus"))
      storage.set(STORAGE_KEYS.sidebarOpen, String(open));
    for (const selector of ["#toggleSidebar", "#workspaceNavigationToggle"]) {
      $(selector).setAttribute("aria-expanded", String(visible));
      $(selector).setAttribute("aria-pressed", String(visible));
    }
  }
  function syncSidebarLayout() {
    const mobile = mobileSidebarEnabled();
    if (mobile === sidebarLayoutMobile) return;
    sidebarLayoutMobile = mobile;
    syncSidebarSections();
    setMessageHtml($("#toggleSidebar"), codexIcon(mobile ? "menu" : "panelLeft"));
    setMessageHtml($("#workspaceNavigationToggle"), codexIcon(mobile ? "menu" : "panelLeft"));
    setSidebarOpen(
      !mobile &&
        !document.body.classList.contains("document-navigation-focus") &&
        storage.get(STORAGE_KEYS.sidebarOpen) !== "false",
      { temporary: true },
    );
  }
  function setSidebarSearchOpen(open) {
    const panel = $("#sidebarSearchPanel"),
      input = $("#threadSearch");
    if (open) selectSidebarTab("menu");
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
  function mobileSidebarEnabled() {
    return innerWidth < 768;
  }
  function bind() {
    $("#sidebarMenuTab").onclick = () => selectSidebarTab("menu", { focus: true });
    $("#sidebarSessionsTab").onclick = () => selectSidebarTab("sessions", { focus: true });
    $("#sidebarSectionTabs").onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSidebarOpen(false);
      } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        selectSidebarTab(
          event.key === "Home"
            ? "menu"
            : event.key === "End"
              ? "sessions"
              : sidebarTab === "menu"
                ? "sessions"
                : "menu",
          { focus: true },
        );
      }
    };
    $("#productModeButton").onclick = () => noticesPort.toast(t("common.currentEngineCodex"));
    $("#sidebarSearchButton").onclick = (event) => {
      event.stopPropagation();
      setSidebarSearchOpen($("#sidebarSearchPanel").hidden);
    };
    $("#sidebarSearchClose").onclick = () => setSidebarSearchOpen(false);
    $("#sidebarSettings").onclick = () => settingsPort.openSettings("general-settings");
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
  };
}
