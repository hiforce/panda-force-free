import { threadInputErrorMessage } from "../../shared/bridge-errors.js";

// Owns the session details view and explicit rename/copy actions.
export function assembleDetails({
  sessions,
  transportPort,
  viewUpdates,
  mutations,
  t,
  state,
  $,
  modelsPort,
  clipboardPort,
  noticesPort,
}) {
  function sessionMarker(id) {
    return id ? `${id.slice(0, 12)}…` : t("No active session");
  }
  function sessionModelDetails(thread = state.active) {
    const id = thread?.id,
      session = id && state.sessionSettings.get(id),
      modelId = thread?.model || session?.model || "",
      catalog = state.models.find((item) => item.model === modelId),
      label = modelId ? (catalog ? modelsPort.modelDisplay(catalog) : modelId) : t("Model unavailable"),
      effort = thread?.reasoningEffort || session?.effort || "";
    return { label, modelId, effort };
  }
  function syncSummaryPanel() {
    const workspace = state.projectless ? "No project" : $("#projectName").textContent || "Local workspace",
      id = state.active?.id || "",
      marker = $("#summarySessionMarker"),
      copy = $("#copySummarySessionMarker"),
      name = $("#summarySessionName"),
      save = $("#saveSummarySessionName"),
      model = $("#summarySessionModel"),
      effortEl = $("#summarySessionEffort"),
      details = sessionModelDetails();
    $("#summaryWorkspace").textContent = workspace;
    $("#summaryBranch").textContent = state.projectless
      ? ""
      : state.active?.source === "remote"
        ? "Remote workspace"
        : "Local workspace";
    if ($("#summarySessionTitle")) $("#summarySessionTitle").textContent = t("Session");
    if ($("#summarySessionHelp"))
      $("#summarySessionHelp").textContent = t("Send this marker when reporting a session problem.");
    if (marker) {
      marker.textContent = sessionMarker(id);
      marker.title = id || t("No active session");
      marker.dataset.sessionId = id;
    }
    if (copy) {
      copy.disabled = !id;
      copy.title = t("Copy session marker");
      copy.setAttribute("aria-label", t("Copy session marker"));
    }
    if (model) {
      model.textContent = details.label;
      model.title = details.modelId || t("Model unavailable");
    }
    if (effortEl) effortEl.textContent = details.effort ? modelsPort.reasoningLabel(details.effort) : "";
    if (name) {
      if (document.activeElement !== name) name.value = state.active?.name || "";
      name.disabled = !id;
      name.placeholder = t("Auto-generated from first message");
    }
    if (save) {
      save.disabled = !id;
      save.textContent = t("Save session name");
    }
  }
  async function copySummarySessionMarker() {
    const id = state.active?.id;
    if (!id) return;
    try {
      await clipboardPort.copyMessageText(id);
      noticesPort.toast(t("Session marker copied"));
    } catch {
      noticesPort.addPersistentError(t("Copy failed. Please select and copy the message manually."));
    }
  }
  async function renameActiveSession() {
    const threadId = state.active?.id,
      input = $("#summarySessionName"),
      button = $("#saveSummarySessionName"),
      name = input?.value.trim();
    if (!threadId || !input) return;
    if (!name) {
      noticesPort.addPersistentError(t("Session name cannot be empty"));
      input.focus();
      return;
    }
    button.disabled = true;
    try {
      const result = await transportPort.rpc("thread/name/set", { threadId, name });
      if (state.active?.id === threadId)
        mutations.edit("active", (record) => (record.name = result?.thread?.name || name));
      const thread = state.threads.find((item) => item.id === threadId);
      if (thread) sessions.upsertSummary({ id: threadId, name: result?.thread?.name || name });
      viewUpdates.request("sidebar");
      viewUpdates.request("header");
      syncSummaryPanel();
      noticesPort.toast(t("Session renamed"));
    } catch (error) {
      noticesPort.addPersistentError(threadInputErrorMessage(error));
    } finally {
      syncSummaryPanel();
    }
  }
  function bind() {
    $("#copySummarySessionMarker").onclick = (...args) => copySummarySessionMarker(...args);
    $("#saveSummarySessionName").onclick = (...args) => renameActiveSession(...args);
    $("#summarySessionName").onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        renameActiveSession();
      }
    };
  }
  return {
    bind,
    syncSummaryPanel,
  };
}
