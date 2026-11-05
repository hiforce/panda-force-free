import { SUPPORTED_LOCALES, localizeText, setOpaqueText } from "../i18n.js";
import { findElement } from "./../dom.js";

// Refreshes localized UI surfaces while preserving conversation content.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "$" | "i18n" | "state" | "t", "workspace" | "account" | "models" | "usage" | "notices" | "settings", "localization">} options */
export function assembleLocalization({
  viewUpdates,
  $,
  i18n,
  state,
  t,
  workspacePort,
  accountPort,
  modelsPort,
  usagePort,
  noticesPort,
  settingsPort,
}) {
  function refreshLocalizedRuntime() {
    $("#languageSelect").value = i18n.preference;
    if (!state.active && ["new", "task"].includes(document.body.dataset.workbenchPage || ""))
      localizeText($("#threadTitle"), "common.newSession", undefined, t);
    if (!workspacePort.folderBrowse.selected)
      localizeText($("#folderSelection"), "common.noFolderSelected", undefined, t);
    if (state.account) accountPort.renderAccount(state.account);
    else
      for (const id of ["accountName", "accountMenuName", "settingsAccountName"])
        localizeText($(`#${id}`), "common.settings", undefined, t);
    modelsPort.syncPermissionControl();
    modelsPort.syncModelLabel();
    viewUpdates.request("composerPlaceholder");
    viewUpdates.request("contextUsage");
    viewUpdates.request("review");
    viewUpdates.request("composerSubmit");
    usagePort.renderUsage();
    noticesPort.renderPersistentErrors();
    viewUpdates.request("goals");
    viewUpdates.request("status");
    if (!$("#modelMenu").hidden) modelsPort.renderModelMenuMain();
    if ($("#settingsDialog").open) {
      const current =
        findElement("[data-settings-page].active")?.dataset.settingsPage ||
        settingsPort.settingsRoutePage() ||
        "general-settings";
      settingsPort.setSettingsPage(current, { updateRoute: false });
      settingsPort.filterSettingsNavigation($("#settingsSearch").value);
    }
  }
  function bind() {
    const select = $("#languageSelect");
    const system = document.createElement("option");
    system.value = "system";
    localizeText(system, "common.systemDefault", undefined, t);
    select.replaceChildren(system);
    for (const locale of SUPPORTED_LOCALES) {
      const option = document.createElement("option");
      option.value = locale.code;
      setOpaqueText(option, locale.name);
      select.append(option);
    }
    select.value = i18n.preference;
    $("#languageSelect").onchange = (event) => i18n.setPreference($("#languageSelect").value);
  }

  return {
    refreshLocalizedRuntime,
    bind,
  };
}
