// Refreshes localized UI surfaces while preserving conversation content.
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
    if (!state.active) $("#threadTitle").textContent = t("New session");
    if (!workspacePort.folderBrowse.selected) $("#folderSelection").textContent = t("No folder selected");
    if (state.account) accountPort.renderAccount(state.account);
    else
      for (const id of ["accountName", "accountMenuName", "settingsAccountName"])
        $(`#${id}`).textContent = t("Settings");
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
        document.querySelector("[data-settings-page].active")?.dataset.settingsPage ||
        settingsPort.settingsRoutePage() ||
        "general-settings";
      settingsPort.setSettingsPage(current, { updateRoute: false });
      settingsPort.filterSettingsNavigation($("#settingsSearch").value);
    }
  }
  function bind() {
    $("#languageSelect").value = i18n.preference;
    $("#languageSelect").onchange = (event) => i18n.setPreference(event.currentTarget.value);
  }

  return {
    refreshLocalizedRuntime,
    bind,
  };
}
