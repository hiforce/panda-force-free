import { createRuntimeModelField } from "../harness/model-field.js";
import { syncComposerPanelViewport } from "../session-controls/menu.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { closestElement, requireElement } from "../dom.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { sessionModelFields } from "./model-fields.js";
import { mountReasoningSlider } from "../session-controls/reasoning-slider.js";

/** An edit buffer lives only for the open dialog; Cancel never writes engine settings. */
/** @param {import('../contracts/session-workspace.js').SessionSettingsDialogOptions} options */
export function createSessionSettingsDialog({
  t,
  read,
  applyModel,
  applyPermission,
  reloadModels,
  onError,
  applyRuntimeModel,
}) {
  const dialog = document.createElement("dialog");
  dialog.id = "sessionSettingsDialog";
  dialog.className = "session-dialog session-settings-dialog composer-panel";
  dialog.setAttribute("aria-labelledby", "sessionSettingsDialogTitle");
  document.body.append(dialog);
  let sessionId = "",
    kind = "model",
    model = "",
    effort = "",
    permission = "";
  let returnFocus = /** @type {HTMLElement | null} */ (null);
  let navigation = /** @type {import('./composer-settings.js').ComposerSettingsNavigation | null} */ (null);
  let draftFlow = -1;
  let catalogSignature = "";
  let saving = false;
  let runtimeDraft = /** @type {import("../../shared/engine/runtime-selection.js").RuntimeSelection | null} */ (null);
  let runtimeField = /** @type {ReturnType<typeof createRuntimeModelField> | null} */ (null);
  const label = (key) => messageHtml(key, undefined, t);
  function renderEfforts() {
    const selected = read().models.find((item) => item.id === model);
    const choices = selected?.efforts || [];
    if (!choices.some((item) => item.id === effort)) effort = selected?.defaultEffort || choices[0]?.id || "";
    if (!choices.some((item) => item.id === effort)) effort = choices[0]?.id || "";
    mountReasoningSlider(
      requireElement("#sessionSettingEfforts"),
      choices,
      effort,
      t("common.reasoningEffort"),
      (value) => {
        effort = value;
      },
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
    const applicationSelection =
      kind === "model" && (!!snapshot.runtimeId || snapshot.permissionOwner === "creation") && !!applyRuntimeModel;
    runtimeField?.close();
    runtimeField = applicationSelection
      ? createRuntimeModelField(
          t,
          "session-runtime",
          () => {
            if (dialog.open && runtimeField)
              requireElement('#sessionSettingsForm button[type="submit"]').disabled = !runtimeField.ready();
          },
          snapshot.permissionOwner === "creation" ? "creation" : true,
        )
      : null;
    const fields =
      kind === "model"
        ? runtimeField
          ? runtimeField.html() +
            (snapshot.permissionOwner === "creation"
              ? `<p class="session-caption">${label("harness.mediaHint")}</p>`
              : "")
          : `${navigation ? `<div class="composer-settings-models" role="group" aria-label="${escapeHtml(t("common.selectModel"))}">${snapshot.models.map((item) => `<button type="button" class="composer-settings-row" data-settings-model="${escapeHtml(item.id)}" aria-pressed="${item.id === model}">${codexIcon("sparkles")}<span><strong>${escapeHtml(item.label)}</strong></span>${item.id === model ? codexIcon("check") : ""}</button>`).join("")}</div><div class="session-effort-fieldset" id="sessionSettingEfforts"></div>` : sessionModelFields(snapshot.models, { model, effort }, t)}
          ${snapshot.models.length ? "" : `<button type="button" class="session-button" id="sessionReloadModels">${label("sessions.retryLoadingModels")}</button>`}
          `
        : `<fieldset class="session-permission-fieldset">
            <legend class="sr-only">${label("common.permissions")}</legend>
            ${snapshot.permissions.map((item) => `<label class="session-permission-choice ${item.allowed ? "" : "unavailable"}"><input type="radio" name="session-permission" value="${escapeHtml(item.id)}" ${item.id === permission ? "checked" : ""} ${item.allowed ? "" : "disabled"} /><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small>${item.unavailableReason ? `<small data-permission-unavailable>${escapeHtml(item.unavailableReason)}</small>` : ""}</span></label>`).join("")}
          </fieldset>`;
    setMessageHtml(
      dialog,
      `<header class="session-dialog-heading composer-panel-heading">
        ${navigation ? `<button type="button" class="composer-panel-action" data-settings-back aria-label="${escapeHtml(t("common.back"))}">${codexIcon("chevronLeft")}</button>` : ""}
        <div><p class="session-eyebrow">PandaForce</p><h2 id="sessionSettingsDialogTitle" tabindex="-1">${label(kind === "model" ? "sessionview.modelReasoning" : "common.permissions")}</h2></div>
        <button type="button" class="composer-panel-action" data-settings-dismiss aria-label="${escapeHtml(t("common.close"))}">${codexIcon("x")}</button>
      </header>
      <form id="sessionSettingsForm" class="session-dialog-form">
        <div class="session-dialog-body"><p class="session-caption">${label(snapshot.settingsHint || "sessionview.nextInstruction")}</p>${fields}</div>
        <footer class="session-dialog-actions">
          <button type="button" class="session-button" data-settings-dismiss>${label("common.cancel")}</button>
          <button type="submit" class="session-button primary" ${canSave || applicationSelection ? "" : "disabled"}>${label("sessionview.saveSettings")}</button>
        </footer>
      </form>`,
    );
    if (runtimeField) {
      requireElement('#sessionSettingsForm button[type="submit"]').disabled = true;
      void runtimeField.mount(dialog, {
        ...(runtimeDraft || { runtimeId: snapshot.runtimeId || undefined, model, effort }),
      });
    } else if (kind === "model") renderEfforts();
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  /** @param {string} nextKind @param {import('./composer-settings.js').ComposerSettingsNavigation | null} [nextNavigation] */
  function open(nextKind, nextNavigation = null) {
    const snapshot = read();
    if (!snapshot.sessionId || (nextKind === "permissions" && snapshot.hidePermissionSetting)) return;
    returnFocus =
      nextNavigation?.trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const preserve = nextNavigation && nextNavigation.flow === draftFlow && sessionId === snapshot.sessionId;
    navigation = nextNavigation;
    draftFlow = nextNavigation?.flow ?? -1;
    dialog.classList.toggle("composer-settings-detail", Boolean(navigation));
    sessionId = snapshot.sessionId;
    kind = nextKind;
    if (!preserve) {
      runtimeDraft = null;
      model = snapshot.model;
      effort = snapshot.effort;
      permission = snapshot.permission;
    }
    render();
    if (!dialog.open) dialog.showModal();
    syncComposerPanelViewport(dialog);
    returnFocus?.setAttribute("aria-expanded", "true");
    requireElement("#sessionSettingsDialogTitle").focus({ preventScroll: true });
  }
  function sync() {
    if (!dialog.open) return;
    const snapshot = read();
    if (snapshot.sessionId !== sessionId) close();
    else if (
      !runtimeField &&
      JSON.stringify(kind === "model" ? snapshot.models : snapshot.permissions) !== catalogSignature
    ) {
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
    if (closestElement("[data-settings-back]", event.target)) {
      const back = navigation?.back;
      close();
      requestAnimationFrame(() => back?.());
      return;
    }
    const selectedModel = closestElement("[data-settings-model]", event.target)?.dataset.settingsModel;
    if (selectedModel && read().models.some((item) => item.id === selectedModel)) {
      model = selectedModel;
      render();
      const choice = dialog.querySelector(`[data-settings-model="${CSS.escape(model)}"]`);
      if (choice instanceof HTMLElement) choice.focus({ preventScroll: true });
    }
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
    if (target instanceof HTMLInputElement && target.name === "session-permission") {
      permission = target.value;
      requireElement('#sessionSettingsForm button[type="submit"]').disabled = !read().permissions.some(
        (item) => item.id === permission && item.allowed,
      );
    }
  });
  dialog.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    if (read().sessionId !== sessionId) {
      close();
      onError(t("sessionview.sessionChanged"));
      return;
    }
    try {
      // Close before the existing full-access confirmation is allowed to open.
      if (runtimeField) {
        const runtime = runtimeField.runtime();
        if (!runtimeField.ready() || !runtime || !applyRuntimeModel) throw new Error(t("harness.selectionError"));
        saving = true;
        runtimeField.setLocked(true);
        requireElement('#sessionSettingsForm button[type="submit"]').disabled = true;
        await applyRuntimeModel(sessionId, runtimeField.read(), runtime);
        close();
        return;
      }
      close();
      if (kind === "model") applyModel(sessionId, model, effort);
      else applyPermission(sessionId, permission);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
      runtimeField?.setLocked(false);
      if (dialog.open && runtimeField)
        requireElement('#sessionSettingsForm button[type="submit"]').disabled = !runtimeField.ready();
    }
  });
  dialog.addEventListener("close", () => {
    if (runtimeField) runtimeDraft = runtimeField.read();
    runtimeField?.close();
    runtimeField = null;
    returnFocus?.setAttribute("aria-expanded", "false");
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
  });
  const viewport = () => {
    if (dialog.open) syncComposerPanelViewport(dialog);
  };
  window.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("scroll", viewport);
  return { open, close, sync };
}
