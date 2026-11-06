import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { closestElement, requireElement } from "../dom.js";
import { messageHtml, setMessageHtml } from "../i18n.js";

/** An edit buffer lives only for the open dialog; Cancel never writes engine settings. */
/** @param {import('../contracts/session-workspace.js').SessionSettingsDialogOptions} options */
export function createSessionSettingsDialog({ t, read, applyModel, applyPermission, reloadModels, onError }) {
  const dialog = document.createElement("dialog");
  dialog.id = "sessionSettingsDialog";
  dialog.className = "session-dialog session-settings-dialog";
  dialog.setAttribute("aria-labelledby", "sessionSettingsDialogTitle");
  document.body.append(dialog);
  let sessionId = "",
    kind = "model",
    model = "",
    effort = "",
    permission = "";
  let returnFocus = /** @type {HTMLElement | null} */ (null);
  let catalogSignature = "";
  const label = (key) => messageHtml(key, undefined, t);
  function renderEfforts() {
    const selected = read().models.find((item) => item.id === model);
    const choices = selected?.efforts || [];
    if (!choices.some((item) => item.id === effort)) effort = selected?.defaultEffort || choices[0]?.id || "";
    if (!choices.some((item) => item.id === effort)) effort = choices[0]?.id || "";
    setMessageHtml(
      requireElement("#sessionSettingEfforts"),
      choices
        .map(
          (item) =>
            `<label><input type="radio" name="session-effort" value="${escapeHtml(item.id)}" ${item.id === effort ? "checked" : ""}/><span>${escapeHtml(item.label)}</span></label>`,
        )
        .join(""),
    );
  }
  function render() {
    const snapshot = read();
    if (!snapshot.models.some((item) => item.id === model)) {
      model = snapshot.models.find((item) => item.id === snapshot.model)?.id || snapshot.models[0]?.id || "";
      effort = snapshot.effort;
    }
    catalogSignature = JSON.stringify(kind === "model" ? snapshot.models : snapshot.permissions);
    const canSave =
      kind === "model"
        ? snapshot.models.length > 0
        : snapshot.permissions.some((item) => item.id === permission && item.allowed);
    const fields =
      kind === "model"
        ? `<label class="session-form-label" for="sessionSettingModel">${label("common.model")}</label>
          <select class="session-field" id="sessionSettingModel" ${snapshot.models.length ? "" : "disabled"}>
            ${snapshot.models.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === model ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
          </select>
          ${snapshot.models.length ? "" : `<button type="button" class="session-button" id="sessionReloadModels">${label("sessions.retryLoadingModels")}</button>`}
          <fieldset class="session-effort-fieldset">
            <legend>${label("common.reasoningEffort")}</legend>
            <div class="session-effort-segments" id="sessionSettingEfforts"></div>
          </fieldset>`
        : `<fieldset class="session-permission-fieldset">
            <legend class="sr-only">${label("common.permissions")}</legend>
            ${snapshot.permissions.map((item) => `<label class="session-permission-choice ${item.allowed ? "" : "unavailable"}"><input type="radio" name="session-permission" value="${escapeHtml(item.id)}" ${item.id === permission ? "checked" : ""} ${item.allowed ? "" : "disabled"} /><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span></label>`).join("")}
          </fieldset>`;
    setMessageHtml(
      dialog,
      `<header class="session-dialog-heading">
        <div><p class="session-eyebrow">PandaForce</p><h2 id="sessionSettingsDialogTitle" tabindex="-1">${label(kind === "model" ? "sessionview.modelReasoning" : "common.permissions")}</h2></div>
        <button type="button" class="icon-button" data-settings-dismiss aria-label="${escapeHtml(t("common.close"))}">${codexIcon("x")}</button>
      </header>
      <form id="sessionSettingsForm" class="session-dialog-form">
        <div class="session-dialog-body"><p class="session-caption">${label("sessionview.nextInstruction")}</p>${fields}</div>
        <footer class="session-dialog-actions">
          <button type="button" class="session-button" data-settings-dismiss>${label("common.cancel")}</button>
          <button type="submit" class="session-button primary" ${canSave ? "" : "disabled"}>${label("sessionview.saveSettings")}</button>
        </footer>
      </form>`,
    );
    if (kind === "model") renderEfforts();
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  function open(nextKind) {
    const snapshot = read();
    if (!snapshot.sessionId) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sessionId = snapshot.sessionId;
    kind = nextKind;
    model = snapshot.model;
    effort = snapshot.effort;
    permission = snapshot.permission;
    render();
    if (!dialog.open) dialog.showModal();
    returnFocus?.setAttribute("aria-expanded", "true");
    requireElement("#sessionSettingsDialogTitle").focus({ preventScroll: true });
  }
  function sync() {
    if (!dialog.open) return;
    const snapshot = read();
    if (snapshot.sessionId !== sessionId) close();
    else if (JSON.stringify(kind === "model" ? snapshot.models : snapshot.permissions) !== catalogSignature) {
      const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
      const selector = focused?.id
        ? `#${CSS.escape(focused.id)}`
        : focused instanceof HTMLInputElement
          ? `input[name="${CSS.escape(focused.name)}"][value="${CSS.escape(focused.value)}"]`
          : "";
      render();
      const next = selector ? dialog.querySelector(selector) : null;
      if (next instanceof HTMLElement) next.focus({ preventScroll: true });
    }
  }
  dialog.addEventListener("click", async (event) => {
    if (closestElement("[data-settings-dismiss]", event.target)) close();
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        close();
    }
    if (closestElement("#sessionReloadModels", event.target)) {
      const button = requireElement("#sessionReloadModels");
      button.disabled = true;
      await reloadModels();
      if (dialog.open && read().sessionId === sessionId) render();
    }
  });
  dialog.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.id === "sessionSettingModel") {
      model = target.value;
      renderEfforts();
    }
    if (target instanceof HTMLInputElement && target.name === "session-effort") effort = target.value;
    if (target instanceof HTMLInputElement && target.name === "session-permission") {
      permission = target.value;
      requireElement('#sessionSettingsForm button[type="submit"]').disabled = !read().permissions.some(
        (item) => item.id === permission && item.allowed,
      );
    }
  });
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (read().sessionId !== sessionId) {
      close();
      onError(t("sessionview.sessionChanged"));
      return;
    }
    try {
      // Close before the existing full-access confirmation is allowed to open.
      close();
      if (kind === "model") applyModel(sessionId, model, effort);
      else applyPermission(sessionId, permission);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  });
  dialog.addEventListener("close", () => {
    returnFocus?.setAttribute("aria-expanded", "false");
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
  });
  return { open, close, sync };
}
