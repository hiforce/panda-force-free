import { reasoningLabel as runtimeReasoningLabel } from "./harness/reasoning-label.js";
import { supportedEffort } from "../shared/engine/runtime-selection.js";
import { createSessionPermissionControls } from "./session-controls/permissions.js";
import { mountReasoningSlider } from "./session-controls/reasoning-slider.js";
import { focusMenuSelection, bindMenuDismiss, mountSessionMenu, restoreSessionMenu } from "./session-controls/menu.js";
import { createSessionModelCache } from "./session-controls/model-cache.js";
import { createModelCatalogLoader } from "./session-controls/model-loader.js";
import { createTaskCompletionNotifications } from "./session-controls/notifications.js";
import { errorCode, errorMessage } from "../shared/errors.js";
import { findElement, requireElement } from "./dom.js";
import { localizeAttribute, messageAttributes, messageHtml, setMessageHtml, setOpaqueText } from "./i18n.js";
import { codexIcon } from "./codex-icons.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { selectModelState } from "./ui-core.js";
/**
 * Session controls: model/effort selection with per-thread overrides, the
 * model and permission menus, permission profiles/policies, task-completed
 * notifications and the full-access confirmation dialog. Owns its control
 * DOM events; transport and app surfaces are injected.
 */
export function createSessionControls({
  $,
  t,
  state,
  rpc,
  postBridge,
  escapeHtml,
  toast,
  addPersistentError,
  mutations,
  onSettingsChanged = () => {},
  onModelsLoaded = () => {},
  catalogScope = () => "codex",
  openModelPicker = () => false,
}) {
  const { syncTaskNotifySettings, setTaskNotifyEnabled, maybeNotifyTaskCompleted } = createTaskCompletionNotifications({
    $,
    t,
    threads: () => state.threads,
    toast,
  });
  const cacheKey = (id) => (!id || catalogScope() === "codex" ? id : JSON.stringify([catalogScope(), id]));
  const preferenceKey = (key) => (catalogScope() === "codex" ? key : `${key}:${catalogScope()}`);
  const scopedSettings = (id) => {
    const value = id && state.sessionSettings.get(id);
    return value && (value.runtimeContext || "codex") === catalogScope() ? value : undefined;
  };
  const localModelCache = createSessionModelCache(storage);
  let modelMenuBack = /** @type {(() => void) | null} */ (null);
  let modelMenuTrigger = $("#modelButton");
  const readLocalSessionModelSettings = (threadId = state.active?.id) => localModelCache.read(cacheKey(threadId));
  const writeLocalSessionModelSettings = (threadId, settings) => localModelCache.write(cacheKey(threadId), settings);
  const clearLocalSessionModelSettings = (threadId = state.active?.id) => localModelCache.clear(cacheKey(threadId));
  function commitSessionModelSettings(threadId) {
    if (!threadId) return;
    const current = state.sessionSettings.get(threadId) || {};
    mutations.collection("sessionSettings").set(threadId, {
      ...current,
      model: state.selectedModel,
      effort: $("#effortSelect").value,
      runtimeContext: catalogScope(),
      source: "remote",
    });
    clearLocalSessionModelSettings(threadId);
  }
  const reasoningLabel = (value) => runtimeReasoningLabel(value, t);
  function updateModelLoadUi() {
    syncModelLabel();
    $("#modelButton").setAttribute("aria-busy", String(state.modelLoadStatus === "loading" && !state.models.length));
    if (!$("#modelMenu").hidden) renderModelMenuMain();
  }
  const loadModels = createModelCatalogLoader({
    context: catalogScope,
    contextChanged: () => {
      mutations.set("models", []);
      mutations.set("selectedModel", "");
    },
    request: (signal) =>
      postBridge(
        "/api/rpc",
        { id: mutations.update("rpcId", (value) => value + 1, true), method: "model/list", params: { limit: 50 } },
        signal,
      ),
    setStatus: (status) => mutations.set("modelLoadStatus", status),
    changed: updateModelLoadUi,
    accept: (models) => {
      mutations.set("models", models);
      renderModels();
      onModelsLoaded();
    },
    failed: (error) =>
      addPersistentError(
        errorCode(error) === "model_catalog_timeout"
          ? { messageId: "errors.modelLoadTimedOut" }
          : errorMessage(error, t("errors.couldNotLoadModels")),
        { key: "model-load" },
      ),
  });
  function modelDisplay(model, stripPrefix = false) {
    const value = String(model?.displayName || model?.model || state.selectedModel || "Select model").trim();
    if (!stripPrefix) return value;
    return value.replace(/^GPT-/i, "").trim() || value;
  }
  function selectedModel() {
    return state.models.find((x) => x.model === state.selectedModel);
  }
  function renderModels() {
    mutations.set("modelLoadStatus", "ready");
    $("#modelButton").setAttribute("aria-busy", "false");
    const session = scopedSettings(state.active?.id),
      local = readLocalSessionModelSettings(),
      saved = local?.model || session?.model || storage.get(preferenceKey(STORAGE_KEYS.model)),
      selection = selectModelState(state.models, saved);
    mutations.set("selectedModel", selection.model);
    updateEfforts(
      local?.effort || session?.effort || session?.reasoningEffort || selection.effort,
      Boolean(local?.effort || session?.effort || session?.reasoningEffort),
    );
    syncModelLabel();
    renderModelMenuMain();
  }
  /** @param {string} threadId @param {{model?: string; reasoningEffort?: string; effort?: string; runtimeContext?: string; threadSettings?: {runtimeContext?: string; model?: string; effort?: string; reasoningEffort?: string}}} settings */
  function applySessionSettings(threadId, settings = {}) {
    if (!threadId || !settings || typeof settings !== "object") return;
    const model = settings.model || settings.threadSettings?.model,
      effort =
        settings.reasoningEffort ??
        settings.effort ??
        settings.threadSettings?.effort ??
        settings.threadSettings?.reasoningEffort;
    if (!model && !effort) return;
    const current = state.sessionSettings.get(threadId) || {};
    mutations.collection("sessionSettings").set(threadId, {
      ...current,
      runtimeContext: settings.runtimeContext || settings.threadSettings?.runtimeContext || "codex",
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      source: "session",
    });
    if (state.active?.id === threadId && state.models.length && scopedSettings(threadId)) {
      const session = state.sessionSettings.get(threadId),
        local = readLocalSessionModelSettings(threadId);
      if (
        (local?.model || session.model) &&
        state.models.some((item) => item.model === (local?.model || session.model))
      )
        mutations.set("selectedModel", local?.model || session.model);
      updateEfforts(local?.effort || session.effort, true);
      syncModelLabel();
      renderModelMenuMain();
    }
  }
  function chooseModel(model, keepOpen = false) {
    const previous = $("#effortSelect").value;
    mutations.set("selectedModel", model);
    storage.set(preferenceKey(STORAGE_KEYS.model), model);
    if (state.active?.id) {
      mutations.collection("sessionSettings").set(state.active.id, {
        ...(state.sessionSettings.get(state.active.id) || {}),
        model,
        effort: previous,
        runtimeContext: catalogScope(),
        source: "user",
      });
      writeLocalSessionModelSettings(state.active.id, { model, effort: previous });
    }
    updateEfforts(previous);
    syncModelLabel();
    if (keepOpen) renderModelMenuMain();
    else closeModelMenu();
    toast(t("common.modelChanged", { model: modelDisplay(selectedModel()) }));
  }
  function syncModelLabel() {
    const model = selectedModel();
    setOpaqueText(
      $("#modelLabel"),
      state.models.length
        ? modelDisplay(model, true)
        : t(state.modelLoadStatus === "error" ? "common.modelLoadFailedRetry" : "common.loadingModels"),
    );
    setOpaqueText($("#effortLabel"), reasoningLabel($("#effortSelect").value));
    syncModelDescription();
    onSettingsChanged();
  }
  function syncModelDescription() {
    const values = {
      model: state.models.length
        ? modelDisplay(selectedModel())
        : t(state.modelLoadStatus === "error" ? "common.modelLoadFailedRetry" : "common.loadingModels"),
      level: reasoningLabel($("#effortSelect").value),
    };
    for (const attribute of ["aria-label", "title"])
      localizeAttribute($("#modelButton"), attribute, "common.modelAndReasoningSetting", values, t);
  }
  function updateEfforts(preferred, preferPreferred = false) {
    const model = selectedModel(),
      effort = $("#effortSelect");
    setMessageHtml(effort, "");
    const supported = model?.supportedReasoningEfforts || [],
      values = supported.map((item) => item.reasoningEffort).filter(Boolean),
      local = readLocalSessionModelSettings(),
      saved =
        local?.model === state.selectedModel
          ? local?.effort
          : storage.get(preferenceKey(STORAGE_KEYS.effortFor(state.selectedModel))),
      preferredValue = (preferPreferred ? [preferred, saved] : [saved, preferred]).find((value) =>
        values.includes(value),
      ),
      selected = supportedEffort(values, preferredValue, model?.defaultReasoningEffort || "");
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      setOpaqueText(option, value);
      option.selected = value === selected;
      effort.append(option);
    }
    setOpaqueText($("#effortLabel"), reasoningLabel(effort.value));
    syncModelDescription();
  }
  function contextUsageValue(tokenUsage) {
    const contextWindow = Number(tokenUsage?.modelContextWindow),
      totalTokens = Number(tokenUsage?.last?.totalTokens);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(totalTokens) || totalTokens < 0)
      return null;
    const usedTokens = Math.min(totalTokens, contextWindow),
      percent = (usedTokens / contextWindow) * 100;
    return Number.isFinite(percent)
      ? { percent, usedTokens, contextWindow, remainingTokens: Math.max(contextWindow - usedTokens, 0) }
      : null;
  }
  function renderContextUsage() {
    const indicator = $("#contextUsage"),
      usage = state.active?.id ? contextUsageValue(state.tokenUsage.get(state.active.id)) : null;
    if (!indicator) return;
    if (!usage) {
      indicator.hidden = true;
      indicator.removeAttribute("data-tooltip");
      return;
    }
    const percent = Math.max(0, Math.min(usage.percent, 100)),
      rounded = Math.round(percent),
      remaining = Math.max(0, 100 - rounded),
      usedThousands = Math.round(usage.usedTokens / 1000),
      windowThousands = Math.round(usage.contextWindow / 1000);
    indicator.hidden = false;
    indicator.style.setProperty("--context-percent", String(percent));
    localizeAttribute(indicator, "aria-label", "common.contextLabel", { percent: rounded }, t);
    localizeAttribute(
      indicator,
      "data-tooltip",
      "common.contextTooltip",
      { percent: rounded, remaining, used: usedThousands, total: windowThousands },
      t,
    );
  }
  function menuTitle(text, back = false) {
    return `<div class="model-menu-title-row composer-panel-heading">${back ? `<button type="button" class="model-menu-back composer-panel-action" id="modelMenuBack" aria-label="Back" data-pf-aria-label="common.back">${codexIcon("chevronLeft")}</button>` : ""}<div class="model-menu-title">${messageHtml(text, undefined, t)}</div><button type="button" class="session-menu-close composer-panel-action" ${messageAttributes("aria-label", "common.close", undefined, t)}>${codexIcon("x")}</button></div>`;
  }
  function renderModelMenuMain() {
    const menu = $("#modelMenu");
    if (!state.models.length) {
      setMessageHtml(
        menu,
        `${menuTitle("common.selectModel", Boolean(modelMenuBack))}<div class="model-menu-title-row" role="status">${messageHtml(state.modelLoadStatus === "error" ? "errors.couldNotLoadModels" : "common.loadingModels", undefined, t)}</div>${state.modelLoadStatus === "error" ? `<button class="model-option" type="button" id="retryModels">${messageHtml("sessions.retryLoadingModels", undefined, t)}</button>` : ""}`,
      );
      bindModelMenuBack(menu);
      findElement("#retryModels", menu)?.addEventListener("click", () => loadModels());
      return;
    }
    const model = selectedModel(),
      effort = $("#effortSelect");
    setMessageHtml(
      menu,
      `<div class="model-menu-view model-menu-view-main">${menuTitle("sessionview.modelReasoning", Boolean(modelMenuBack))}<div class="model-reasoning-slider" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span><span data-pf-message="common.model">Model</span></span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon("chevronRight")}</button></div>`,
    );
    mountReasoningSlider(
      requireElement("[data-model-menu-efforts]", menu),
      [...effort.options].map((option) => ({ id: option.value, label: reasoningLabel(option.value) })),
      effort.value,
      t("common.reasoningEffort"),
      (value) => chooseEffort(value, false),
    );
    requireElement("#modelSubmenuButton", menu).onclick = () => {
      renderModelSubmenu();
      focusMenuSelection(menu);
    };
    bindModelMenuBack(menu);
  }
  function bindModelMenuBack(menu) {
    findElement("#modelMenuBack", menu)?.addEventListener("click", () => {
      closeModelMenu();
      modelMenuBack?.();
    });
  }
  function renderModelSubmenu() {
    const menu = $("#modelMenu");
    setMessageHtml(
      menu,
      `<div class="model-menu-view model-menu-view-models">${menuTitle("common.model", true)}<div class="model-menu-list model-list" role="menu" ${messageAttributes("aria-label", "common.selectModel", undefined, t)}></div></div>`,
    );
    requireElement("#modelMenuBack", menu).onclick = () => {
      renderModelMenuMain();
      focusMenuSelection(menu);
    };
    const list = requireElement(".model-list", menu);
    for (const model of state.models) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-option";
      button.role = "menuitemradio";
      button.dataset.model = model.model;
      button.setAttribute("aria-checked", String(model.model === state.selectedModel));
      setMessageHtml(
        button,
        `<span class="model-option-copy"><strong>${escapeHtml(modelDisplay(model))}</strong>${model.description ? `<small>${escapeHtml(model.description)}</small>` : ""}</span><span class="model-check">${model.model === state.selectedModel ? codexIcon("check") : ""}</span>`,
      );
      button.onclick = () => chooseModel(model.model);
      list.append(button);
    }
  }
  function chooseEffort(value, dismiss = true) {
    const effort = $("#effortSelect");
    if (![...effort.options].some((option) => option.value === value)) return;
    effort.value = value;
    setOpaqueText($("#effortLabel"), reasoningLabel(value));
    syncModelDescription();
    storage.set(preferenceKey(STORAGE_KEYS.effortFor(state.selectedModel)), value);
    if (state.active?.id) {
      mutations.collection("sessionSettings").set(state.active.id, {
        ...(state.sessionSettings.get(state.active.id) || {}),
        model: state.selectedModel,
        effort: value,
        runtimeContext: catalogScope(),
        source: "user",
      });
      writeLocalSessionModelSettings(state.active.id, { model: state.selectedModel, effort: value });
    }
    if (dismiss) {
      closeModelMenu();
      toast(t("common.reasoningLevel", { level: reasoningLabel(value) }));
    }
  }
  /** @param {string} [view] @param {(() => void) | null} [back] */
  function openModelMenu(view = "main", back = null) {
    closePermissionMenu();
    if (openModelPicker()) return;
    modelMenuBack = back;
    modelMenuTrigger = $("#modelButton").getClientRects().length ? $("#modelButton") : $("#composerSettingsButton");
    if (view === "models") renderModelSubmenu();
    else renderModelMenuMain();
    $("#modelMenu").hidden = false;
    mountSessionMenu($("#modelMenu"), modelMenuTrigger, closeModelMenu);
    modelMenuTrigger.setAttribute("aria-expanded", "true");
    focusMenuSelection($("#modelMenu"));
  }
  function toggleModelMenu() {
    const menu = $("#modelMenu");
    if (menu.hidden) {
      if (state.modelLoadStatus === "error") loadModels();
      openModelMenu();
    } else closeModelMenu();
  }
  function closeModelMenu() {
    const menu = $("#modelMenu");
    menu.hidden = true;
    restoreSessionMenu(menu);
    $("#modelButton").setAttribute("aria-expanded", "false");
    modelMenuTrigger.setAttribute("aria-expanded", "false");
  }
  const {
    closePermissionMenu,
    loadPermissionProfiles,
    permissionThreadPolicy,
    permissionTurnPolicy,
    renderPermissionMenu,
    selectedPermission,
    setPermissionMode,
    setPermissionProfiles,
    setPermissionVisibility,
    syncPermissionControl,
    syncPermissionSettings,
    applyPermissionSelection,
    confirmFullAccessSelection,
    permissionsView,
    openPermissionMenu,
  } = createSessionPermissionControls({
    $,
    t,
    state,
    rpc,
    toast,
    mutations,
    onSettingsChanged,
    closeModelMenu,
    syncTaskNotifySettings,
  });
  bindMenuDismiss($("#modelMenu"), () => modelMenuTrigger, closeModelMenu);
  $("#modelButton").addEventListener("click", toggleModelMenu);
  $("#settingsTaskNotifyToggle").onchange = (event) => setTaskNotifyEnabled(event.currentTarget.checked);
  function sessionControlView() {
    return {
      sessionId: state.active?.id || `new:${state.newSessionProjectId || "personal"}`,
      modelLoadStatus: state.modelLoadStatus,
      model: state.selectedModel,
      effort: $("#effortSelect").value,
      permission: state.permissionMode,
      models: state.models.map((model) => ({
        id: model.model,
        label: modelDisplay(model),
        defaultEffort: model.defaultReasoningEffort || "",
        efforts: (model.supportedReasoningEfforts || []).map((item) => ({
          id: item.reasoningEffort,
          label: reasoningLabel(item.reasoningEffort),
        })),
      })),
      permissions: permissionsView(),
    };
  }
  function applyModelSelection(sessionId, model, effort) {
    const view = sessionControlView();
    if (!sessionId || view.sessionId !== sessionId) throw new Error(t("sessionview.sessionChanged"));
    const selected = view.models.find((item) => item.id === model);
    if (!selected || (effort && !selected.efforts.some((item) => item.id === effort)))
      throw new Error(t("errors.couldNotLoadModels"));
    chooseModel(model, true);
    chooseEffort(effort);
  }

  return {
    sessionControlView,
    applyModelSelection,
    applyPermissionSelection,
    confirmFullAccessSelection,
    applySessionSettings,
    closeModelMenu,
    closePermissionMenu,
    commitSessionModelSettings,
    loadModels,
    loadPermissionProfiles,
    maybeNotifyTaskCompleted,
    modelDisplay,
    openModelMenu,
    openPermissionMenu,
    permissionThreadPolicy,
    permissionTurnPolicy,
    reasoningLabel,
    renderContextUsage,
    renderModelMenuMain,
    renderModels,
    renderPermissionMenu,
    selectedModel,
    selectedPermission,
    setPermissionMode,
    setPermissionProfiles,
    setPermissionVisibility,
    syncModelLabel,
    syncPermissionControl,
    syncPermissionSettings,
  };
}
