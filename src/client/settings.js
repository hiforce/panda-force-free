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
    "general-settings": { title: "General" },
    appearance: {
      title: "Appearance",
      rows: [
        ["Theme", "System"],
        ["Language", "System default"],
        ["Interface scale", "Default"],
      ],
    },
    agent: { title: "Configuration" },
    profile: { title: "Profile" },
    usage: { title: "Usage" },
    storage: { title: "Storage and logs" },
    "keyboard-shortcuts": { title: "Keyboard shortcuts" },
    "plugins-settings": {
      title: "Plugins",
      rows: [
        ["Installed plugins", "None"],
        ["Plugin sources", "Not configured"],
      ],
    },
    "skills-settings": { title: "Skills", rows: [["Installed skills", "Not configured"]] },
    "browser-use": {
      title: "Browser",
      rows: [
        ["Browser access", "Not configured"],
        ["Network access", "Inherited from permissions"],
      ],
    },
    "computer-use": { title: "Computer use", rows: [["Computer use", "Not configured"]] },
    connections: { title: "Connections", rows: [["Connected services", "None"]] },
    "cloud-settings": {
      title: "Cloud preferences",
      rows: [
        ["Diff view", "Unified"],
        ["Branch format", "Default"],
      ],
    },
    "cloud-environments": { title: "Cloud environments", rows: [["Environments", "None"]] },
    "code-review": { title: "Code review", rows: [["Review instructions", "Not configured"]] },
    "git-settings": { title: "Git", rows: [["Git integration", "System default"]] },
    "hooks-settings": { title: "Hooks", rows: [["Configured hooks", "None"]] },
    worktrees: { title: "Worktrees", rows: [["Worktree behavior", "Default"]] },
    "data-controls": { title: "Archived chats", rows: [["Archived chats", "None"]] },
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
    title.textContent = t(definition.title);
    description.hidden = true;
    description.textContent = "";
    rows.replaceChildren();
    for (const [label, value] of settingsPlaceholderRows(page)) {
      const row = document.createElement("div");
      row.className = "settings-row settings-readonly-row";
      const copy = document.createElement("span"),
        strong = document.createElement("strong"),
        status = document.createElement("span");
      strong.textContent = t(label);
      copy.append(strong);
      status.textContent = t(value);
      row.append(copy, status);
      rows.append(row);
    }
  }
  function setSettingsPage(page = "general-settings", { updateRoute = true } = {}) {
    const selected = normalizeSettingsPage(page),
      contentPage = ["general-settings", "profile", "keyboard-shortcuts", "appearance", "storage"].includes(selected)
        ? selected
        : "placeholder";
    for (const button of document.querySelectorAll("[data-settings-page]"))
      button.classList.toggle("active", button.dataset.settingsPage === selected);
    for (const content of document.querySelectorAll("[data-settings-content]"))
      content.hidden = content.dataset.settingsContent !== contentPage;
    if (contentPage === "placeholder") renderSettingsPlaceholder(selected);
    const currentButton = document.querySelector(`[data-settings-page="${selected}"]`);
    if (currentButton?.closest("details")) currentButton.closest("details").open = true;
    $("#settingsProductIdentity").textContent =
      globalThis.__pandaForceIdentity?.username ||
      globalThis.__pandaForceIdentity?.account ||
      t("Authenticated PandaForce account");
    applyThemePreference();
    $("#settingsPageTitle").textContent = t(settingsPages[selected].title);
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
    for (const group of document.querySelectorAll("[data-settings-group]")) {
      let groupVisible = 0;
      for (const button of group.querySelectorAll("[data-settings-page]")) {
        const available = button.dataset.settingsAvailable !== "false",
          keywords =
            {
              appearance: ["Theme", "Language", "Light", "Dark"],
              profile: ["PandaForce account", "Account and security"],
              storage: ["Logs", "Storage", "Log retention"],
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
  for (const button of document.querySelectorAll(".settings-page .settings-mobile-back"))
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
    $("#settingsPermissionValue").textContent = t(permissionLabel());
    $("#settingsProjectValue").textContent = state.projectless
      ? t("No project")
      : shortPath(state.active?.cwd || $("#projectPath").textContent);
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
      const target = mobile ? $("#settingsSearch") : document.querySelector(".settings-nav-back");
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
