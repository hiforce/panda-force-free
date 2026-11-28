import { closestElement, findElement, findElements, requireElement } from "./dom.js";
import { localizeText, setOpaqueText } from "./i18n.js";

import { mountMemoryLanguage } from "./settings-pages/memory-language.js";
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
  syncPermissionSettings,
  pageViews = /** @type {Record<string, { show(host: HTMLElement): void; hide(): void }>} */ ({}),
}) {
  /** @type {AbortController | undefined} */
  let systemMemoryLanguage;
  let settingsMobileLayout = matchMedia("(max-width:767px)").matches;

  const settingsPageAliases = {
    "bot-tasks": "bots",
    general: "general-settings",
    account: "profile",
    keyboard: "keyboard-shortcuts",
  };
  const settingsPages = {
    users: { title: "users.title" },
    "encryption-keys": { title: "settings.encryptionKeys" },
    "general-settings": { title: "settings.preferences" },
    appearance: {
      title: "creative.appearance",
      rows: [
        ["common.theme", "common.system"],
        ["common.language", "common.systemDefault"],
        ["common.interfaceScale", "common.default"],
      ],
    },
    "publishing-styles": { title: "plugins.stylesTitle" },
    templates: { title: "templates.title" },
    agent: { title: "harness.title" },
    "media-executors": { title: "creation.mediaSettings" },
    "media-credentials": { title: "creation.credentialSettings" },
    profile: { title: "common.profile" },
    usage: { title: "common.usage" },
    storage: { title: "creative.storage" },
    "search-settings": { title: "search.settingsTitle" },
    bots: { title: "cli.botSettingsTitle" },
    "client-access": { title: "cli.title" },
    "memory-settings": { title: "projects.memory" },
    "keyboard-shortcuts": { title: "common.keyboardShortcuts" },
    "plugins-settings": {
      title: "creative.extensions",
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
    if (
      globalThis.__pandaForceIdentity?.role === "member" &&
      ![
        "general-settings",
        "appearance",
        "users",
        "keyboard-shortcuts",
        "encryption-keys",
        "media-executors",
        "media-credentials",
      ].includes(page)
    )
      page = "users";
    const selected = normalizeSettingsPage(page),
      preferenceSection = { appearance: "appearance", "keyboard-shortcuts": "shortcuts" }[selected],
      visiblePage = preferenceSection ? "general-settings" : selected,
      contentPage = [
        "general-settings",
        "profile",
        "keyboard-shortcuts",
        "appearance",
        "storage",
        ...Object.keys(pageViews),
      ].includes(visiblePage)
        ? visiblePage
        : "placeholder";
    for (const button of findElements("[data-settings-page]"))
      button.classList.toggle("active", button.dataset.settingsPage === visiblePage);
    for (const content of findElements("[data-settings-content]"))
      content.hidden = content.dataset.settingsContent !== contentPage;
    if (contentPage === "placeholder") renderSettingsPlaceholder(selected);
    systemMemoryLanguage?.abort();
    systemMemoryLanguage = undefined;
    if (visiblePage === "general-settings") {
      systemMemoryLanguage = new AbortController();
      mountMemoryLanguage(requireElement("[data-memory-system-language]"), t, systemMemoryLanguage.signal);
    }
    for (const [name, view] of Object.entries(pageViews)) {
      if (name === selected) view.show(requireElement(`[data-settings-view="${name}"]`));
      else view.hide();
    }
    const currentButton = findElement(`[data-settings-page="${visiblePage}"]`);
    const currentGroup = closestElement("details", currentButton);
    if (currentGroup) currentGroup.open = true;
    setOpaqueText(
      $("#settingsProductIdentity"),
      globalThis.__pandaForceIdentity?.username ||
        globalThis.__pandaForceIdentity?.account ||
        t("settings.authenticatedPandaforceAccount"),
    );
    applyThemePreference();
    localizeText($("#settingsPageTitle"), settingsPages[visiblePage].title, undefined, t);
    $("#settingsContent")?.scrollTo({ top: 0 });
    if ($("#settingsDialog").open && matchMedia("(max-width:767px)").matches)
      $("#settingsDialog").dataset.mobilePage = "true";
    const currentPage = settingsRoutePage();
    if (updateRoute && currentPage) {
      const query = selected === "memory-settings" && currentPage === selected ? location.search : "";
      history.replaceState({ ...history.state, pandaForceSettings: true }, "", `/settings/${selected}${query}`);
    }
    if (preferenceSection) requestAnimationFrame(() => jumpToPreference(preferenceSection));
  }
  function jumpToPreference(section) {
    const target = findElement(`[data-preference-section="${section}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    findElement("h2", target)?.focus({ preventScroll: true });
    for (const button of findElements("[data-preferences-jump]")) {
      if (button.dataset.preferencesJump === section) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  }
  function filterSettingsNavigation(query = "") {
    const normalized = query.trim().toLocaleLowerCase(),
      clear = $("#clearSettingsSearch");
    let visible = 0;
    if (clear) clear.hidden = !normalized;
    for (const group of [$("#settingsNavScroll"), ...findElements("details[data-settings-group]")]) {
      let groupVisible = 0;
      for (const button of findElements(":scope > [data-settings-page]", group)) {
        const available =
            button.dataset.settingsAvailable !== "false" &&
            (globalThis.__pandaForceIdentity?.role !== "member" ||
              ["general-settings", "users", "encryption-keys", "media-executors", "media-credentials"].includes(
                button.dataset.settingsPage ?? "",
              )),
          keywords =
            {
              "general-settings": [
                "common.theme",
                "common.language",
                "settings.languageRegion",
                "projects.memoryLanguage",
                "common.light",
                "common.dark",
                "common.permissions",
                "common.notifications",
                "common.keyboardShortcuts",
                "common.workingFolder",
              ],
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
      if (group instanceof HTMLDetailsElement) {
        group.hidden = groupVisible === 0;
        if (normalized && groupVisible) group.open = true;
      }
    }
    const results = $("#settingsSearchResults");
    results.replaceChildren();
    if (normalized) {
      for (const section of findElements("[data-preference-section]")) {
        if (!section.textContent.toLocaleLowerCase().includes(normalized)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.preferencesResult = section.dataset.preferenceSection;
        const heading = findElement("h2", section);
        if (heading?.dataset.pfMessage) localizeText(button, heading.dataset.pfMessage, undefined, t);
        else button.textContent = heading?.textContent || "";
        results.append(button);
      }
    }
    results.hidden = !results.childElementCount;
    if (results.childElementCount) {
      $("#settingsNavScroll > [data-settings-page=general-settings]").hidden = false;
      visible++;
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
    const mobile = matchMedia("(max-width:767px)").matches;
    if (mobile === settingsMobileLayout) return;
    settingsMobileLayout = mobile;
    const dialog = $("#settingsDialog");
    if (dialog.open) dialog.dataset.mobilePage = String(mobile);
  }
  function hideSettings() {
    systemMemoryLanguage?.abort();
    systemMemoryLanguage = undefined;
    for (const view of Object.values(pageViews)) view.hide();
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
  $("#settingsDialog").addEventListener("click", (event) => {
    const button = closestElement("[data-preferences-jump],[data-preferences-result]", event.target);
    if (!button) return;
    if (button.dataset.preferencesResult) setSettingsPage("general-settings");
    jumpToPreference(button.dataset.preferencesResult || button.dataset.preferencesJump);
  });
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
    const redirect = {
      templates: "/skills/writing",
      "skills-settings": "/skills/writing",
      "publishing-styles": "/publish",
      connections: "/connections",
    }[page];
    if (redirect) {
      hideSettings();
      history.replaceState({}, "", redirect);
      queueMicrotask(() => dispatchEvent(new PopStateEvent("popstate")));
      return;
    }
    if (page === "usage") {
      openUsageSummary();
      return;
    }
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
      mobile = matchMedia("(max-width:767px)").matches;
    settingsMobileLayout = mobile;
    dialog.dataset.mobilePage = String(mobile && page !== "general-settings");
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("settings-open");
    requestAnimationFrame(() => {
      const target = mobile ? $("#settingsSearch") : findElement(".settings-nav-back");
      target?.focus();
    });
  }
  /** @param {string} [page] @param {{ route?: string }} [options] */
  function openSettings(page = "general-settings", { route } = {}) {
    if (page === "usage") {
      openUsageSummary();
      return;
    }
    const selected = normalizeSettingsPage(page),
      current = settingsRoutePage();
    const project =
      selected === "memory-settings" && route ? new URL(route, location.origin).searchParams.get("project") : null;
    const destination = `/settings/${selected}${project ? "?" + new URLSearchParams({ project }) : ""}`;
    if (!current) {
      history.pushState(
        { pandaForceSettings: true, codexSettingsReturnPath: location.pathname + location.search + location.hash },
        "",
        destination,
      );
    } else if (current !== selected || (route && destination !== location.pathname + location.search)) {
      history.replaceState({ ...history.state, pandaForceSettings: true }, "", destination);
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
