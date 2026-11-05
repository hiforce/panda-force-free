import { closestElement, findElement, findElements, requireElement } from "./dom.js";
import { localizeText, setOpaqueText } from "./i18n.js";

import { applyThemePreference } from "./theme.js";
/**
 * Settings dialog: page registry, /settings routing, navigation filtering and
 * the responsive mobile layout. Owns its DOM events (dialog buttons, search,
 * resize, popstate); app-specific values come in through the callbacks.
 */
export function createSettingsPanel({
  $,
  t,
  state,
  shortPath,
  agentRows,
  permissionLabel,
  openUsageSummary,
  toggleAccountMenu,
  syncPermissionSettings,
}) {
  let settingsMobileLayout = matchMedia("(max-width:480px)").matches;

  const settingsPageAliases = { general: "general-settings", account: "profile", keyboard: "keyboard-shortcuts" };
  const settingsPages = {
    "general-settings": { title: "common.general" },
    appearance: {
      title: "common.appearance",
      rows: [
        ["common.theme", "common.system"],
        ["common.language", "common.systemDefault"],
        ["common.interfaceScale", "common.default"],
      ],
    },
    agent: { title: "common.configuration" },
    profile: { title: "common.profile" },
    usage: { title: "common.usage" },
    storage: { title: "common.storageAndLogs" },
    "keyboard-shortcuts": { title: "common.keyboardShortcuts" },
    "plugins-settings": {
      title: "common.plugins",
      rows: [
        ["common.installedPlugins", "common.none"],
        ["common.pluginSources", "common.notConfigured"],
      ],
    },
    "skills-settings": { title: "common.skills", rows: [["common.installedSkills", "common.notConfigured"]] },
    "browser-use": {
      title: "common.browser",
      rows: [
        ["common.browserAccess", "common.notConfigured"],
        ["common.networkAccess", "common.inheritedFromPermissions"],
      ],
    },
    "computer-use": { title: "common.computerUse2", rows: [["common.computerUse2", "common.notConfigured"]] },
    connections: { title: "common.connections", rows: [["common.connectedServices", "common.none"]] },
    "cloud-settings": {
      title: "common.cloudPreferences",
      rows: [
        ["common.diffView", "common.unified"],
        ["common.branchFormat", "common.default"],
      ],
    },
    "cloud-environments": { title: "common.cloudEnvironments", rows: [["common.environments", "common.none"]] },
    "code-review": { title: "common.codeReview", rows: [["common.reviewInstructions", "common.notConfigured"]] },
    "git-settings": { title: "common.git", rows: [["common.gitIntegration", "common.systemDefault"]] },
    "hooks-settings": { title: "common.hooks", rows: [["common.configuredHooks", "common.none"]] },
    worktrees: { title: "common.worktrees", rows: [["common.worktreeBehavior", "common.default"]] },
    "data-controls": { title: "common.archivedChats", rows: [["common.archivedChats", "common.none"]] },
  };
  function normalizeSettingsPage(page = "general-settings") {
    const candidate = settingsPageAliases[page] || page;
    return settingsPages[candidate] ? candidate : "general-settings";
  }
  function settingsRoutePage(pathname = location.pathname) {
    const match = pathname.match(/^\/settings(?:\/([^/]+))?\/?$/);
    return match ? normalizeSettingsPage(match[1] || "general-settings") : null;
  }
  function settingsPlaceholderRows(page) {
    if (page === "agent") return agentRows();
    return settingsPages[page]?.rows || [];
  }
  function renderSettingsPlaceholder(page) {
    const definition = settingsPages[page],
      title = $("#settingsPlaceholderTitle"),
      description = $("#settingsPlaceholderDescription"),
      rows = $("#settingsPlaceholderRows");
    localizeText(title, definition.title, undefined, t);
    description.hidden = true;
    setOpaqueText(description, "");
    rows.replaceChildren();
    for (const [label, value] of settingsPlaceholderRows(page)) {
      const row = document.createElement("div");
      row.className = "settings-row settings-readonly-row";
      const copy = document.createElement("span"),
        strong = document.createElement("strong"),
        status = document.createElement("span");
      localizeText(strong, label, undefined, t);
      copy.append(strong);
      localizeText(status, value, undefined, t);
      row.append(copy, status);
      rows.append(row);
    }
  }
  function setSettingsPage(page = "general-settings", { updateRoute = true } = {}) {
    const selected = normalizeSettingsPage(page),
      contentPage = ["general-settings", "profile", "keyboard-shortcuts", "appearance", "storage"].includes(selected)
        ? selected
        : "placeholder";
    for (const button of findElements("[data-settings-page]"))
      button.classList.toggle("active", button.dataset.settingsPage === selected);
    for (const content of findElements("[data-settings-content]"))
      content.hidden = content.dataset.settingsContent !== contentPage;
    if (contentPage === "placeholder") renderSettingsPlaceholder(selected);
    const currentButton = requireElement(`[data-settings-page="${selected}"]`);
    const currentGroup = closestElement("details", currentButton);
    if (currentGroup) currentGroup.open = true;
    setOpaqueText(
      $("#settingsProductIdentity"),
      globalThis.__pandaForceIdentity?.username ||
        globalThis.__pandaForceIdentity?.account ||
        t("settings.authenticatedPandaforceAccount"),
    );
    applyThemePreference();
    localizeText($("#settingsPageTitle"), settingsPages[selected].title, undefined, t);
    $("#settingsContent")?.scrollTo({ top: 0 });
    if ($("#settingsDialog").open && matchMedia("(max-width:480px)").matches)
      $("#settingsDialog").dataset.mobilePage = "true";
    if (updateRoute && settingsRoutePage())
      history.replaceState({ ...history.state, pandaForceSettings: true }, "", `/settings/${selected}`);
  }
  function filterSettingsNavigation(query = "") {
    const normalized = query.trim().toLocaleLowerCase(),
      clear = $("#clearSettingsSearch");
    let visible = 0;
    if (clear) clear.hidden = !normalized;
    for (const group of findElements("details[data-settings-group]")) {
      let groupVisible = 0;
      for (const button of findElements("[data-settings-page]", group)) {
        const available = button.dataset.settingsAvailable !== "false",
          keywords =
            {
              appearance: ["common.theme", "common.language", "common.light", "common.dark"],
              profile: ["common.pandaforceAccount", "common.accountAndSecurity"],
              storage: ["Logs", "Storage", "common.logRetention"],
            }[button.dataset.settingsPage] || [],
          matches =
            !normalized ||
            [
              button.textContent,
              settingsPages[button.dataset.settingsPage]?.title,
              ...keywords,
              ...keywords.map((label) => t(label)),
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalized);
        button.hidden = !available || !matches;
        if (!button.hidden) {
          groupVisible++;
          visible++;
        }
      }
      group.hidden = groupVisible === 0;
      if (normalized && groupVisible) group.open = true;
    }
    $("#settingsNavEmpty").hidden = visible !== 0;
  }
  function clearSettingsSearch() {
    const input = $("#settingsSearch");
    input.value = "";
    filterSettingsNavigation();
    input.focus();
  }
  function showSettingsMobileNavigation() {
    const dialog = $("#settingsDialog");
    dialog.dataset.mobilePage = "false";
    requestAnimationFrame(() => $("#settingsSearch").focus());
  }
  function syncSettingsResponsiveLayout() {
    const mobile = matchMedia("(max-width:480px)").matches;
    if (mobile === settingsMobileLayout) return;
    settingsMobileLayout = mobile;
    const dialog = $("#settingsDialog");
    if (dialog.open) dialog.dataset.mobilePage = String(mobile);
  }
  function hideSettings() {
    const dialog = $("#settingsDialog");
    if (dialog.open) dialog.close();
    document.body.classList.remove("settings-open");
  }
  function closeSettings() {
    if (settingsRoutePage()) {
      if (typeof history.state?.codexSettingsReturnPath === "string") {
        history.back();
        return;
      }
      history.replaceState({}, "", "/workspace");
      hideSettings();
      dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    hideSettings();
  }
  $("#closeSettingsNav").onclick = closeSettings;
  $("#settingsMobileBack").onclick = showSettingsMobileNavigation;
  for (const button of findElements(".settings-page .settings-mobile-back"))
    button.onclick = showSettingsMobileNavigation;
  $("#themeSelect").onchange = (event) => applyThemePreference(event.target.value);
  $("#settingsSearch").oninput = (event) => filterSettingsNavigation(event.currentTarget.value);
  $("#clearSettingsSearch").onclick = clearSettingsSearch;
  $("#settingsSearch").onkeydown = (event) => {
    if (event.key === "Escape" && event.currentTarget.value) {
      event.preventDefault();
      clearSettingsSearch();
    }
  };
  addEventListener("resize", syncSettingsResponsiveLayout);
  addEventListener("popstate", () => {
    const page = settingsRoutePage();
    if (page) {
      showSettings(page, { updateRoute: false });
      return;
    }
    hideSettings();
  });
  function showSettings(page = "general-settings", { updateRoute = true } = {}) {
    if (page === "usage") {
      openUsageSummary();
      return;
    }
    toggleAccountMenu(false);
    syncPermissionSettings();
    localizeText($("#settingsPermissionValue"), permissionLabel(), undefined, t);
    setOpaqueText(
      $("#settingsProjectValue"),
      state.projectless ? t("settings.noProject") : shortPath(state.active?.cwd || $("#projectPath").textContent),
    );
    $("#settingsSearch").value = "";
    filterSettingsNavigation();
    setSettingsPage(page, { updateRoute });
    const dialog = $("#settingsDialog"),
      mobile = matchMedia("(max-width:480px)").matches;
    settingsMobileLayout = mobile;
    dialog.dataset.mobilePage = String(mobile && page !== "general-settings");
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("settings-open");
    requestAnimationFrame(() => {
      const target = mobile ? $("#settingsSearch") : findElement(".settings-nav-back");
      target?.focus();
    });
  }
  function openSettings(page = "general-settings") {
    if (page === "usage") {
      openUsageSummary();
      return;
    }
    const selected = normalizeSettingsPage(page),
      current = settingsRoutePage();
    if (!current) {
      history.pushState(
        { pandaForceSettings: true, codexSettingsReturnPath: location.pathname + location.search + location.hash },
        "",
        `/settings/${selected}`,
      );
    } else if (current !== selected) {
      history.replaceState({ ...history.state, pandaForceSettings: true }, "", `/settings/${selected}`);
    }
    showSettings(selected, { updateRoute: false });
  }

  return {
    openSettings,
    showSettings,
    closeSettings,
    hideSettings,
    setSettingsPage,
    settingsRoutePage,
    filterSettingsNavigation,
  };
}
