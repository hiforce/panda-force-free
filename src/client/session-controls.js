import { errorMessage } from "../shared/errors.js";
import { findElement, requireElement } from "./dom.js";
import {
  localizeAttribute,
  localizeText,
  messageAttributes,
  messageHtml,
  setMessageHtml,
  setOpaqueText,
} from "./i18n.js";
import { createBridgeError } from "../shared/bridge-errors.js";
import { codexIcon } from "./codex-icons.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { createLatestRequestGate, filterAppModels, selectModelState } from "./ui-core.js";
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
}) {
  const permissionProfileRequestGate = createLatestRequestGate();
  let modelLoadPromise = null;
  let pendingFullAccessAction = "select";
  let requestingNotificationPermission = false;
  function readLocalSessionModelSettings(threadId = state.active?.id) {
    if (!threadId) return null;
    try {
      return JSON.parse(storage.get(STORAGE_KEYS.sessionModelCache) || "{}")[threadId] || null;
    } catch {
      return null;
    }
  }
  function writeLocalSessionModelSettings(threadId, settings) {
    if (!threadId) return;
    try {
      const all = JSON.parse(storage.get(STORAGE_KEYS.sessionModelCache) || "{}");
      all[threadId] = { ...(all[threadId] || {}), ...settings };
      storage.set(STORAGE_KEYS.sessionModelCache, JSON.stringify(all));
    } catch {}
  }
  function clearLocalSessionModelSettings(threadId = state.active?.id) {
    if (!threadId) return;
    try {
      const all = JSON.parse(storage.get(STORAGE_KEYS.sessionModelCache) || "{}");
      if (!all[threadId]) return;
      delete all[threadId];
      storage.set(STORAGE_KEYS.sessionModelCache, JSON.stringify(all));
    } catch {}
  }
  function commitSessionModelSettings(threadId) {
    if (!threadId) return;
    const current = state.sessionSettings.get(threadId) || {};
    mutations.collection("sessionSettings").set(threadId, {
      ...current,
      model: state.selectedModel,
      effort: $("#effortSelect").value,
      source: "remote",
    });
    clearLocalSessionModelSettings(threadId);
  }
  const reasoningLabels = {
    none: "common.none",
    minimal: "common.minimal",
    low: "common.low",
    medium: "common.medium",
    high: "common.high",
    xhigh: "common.extraHigh",
    max: "common.max",
    ultra: "common.ultra",
  };
  function reasoningLabel(value) {
    return t(reasoningLabels[value] || String(value || "common.medium"));
  }
  function updateModelLoadUi() {
    syncModelLabel();
    $("#modelButton").setAttribute("aria-busy", String(state.modelLoadStatus === "loading" && !state.models.length));
    if (!$("#modelMenu").hidden) renderModelMenuMain();
  }
  function loadModels({ timeoutMs = 8000, attempts = 3, retryDelayMs = 500 } = {}) {
    if (modelLoadPromise) return modelLoadPromise;
    mutations.set("modelLoadStatus", "loading");
    updateModelLoadUi();
    modelLoadPromise = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          // Catalog reads do not depend on the lifetime of the event WebSocket.
          const message = await postBridge(
            "/api/rpc",
            { id: mutations.update("rpcId", (value) => value + 1, true), method: "model/list", params: { limit: 50 } },
            controller.signal,
          );
          if (message.type !== "rpc/result")
            throw createBridgeError(message.error || "Could not load models", message.code);
          const models = filterAppModels(message.result?.data || []);
          if (!models.length) throw new Error("No models available");
          mutations.set("models", models);
          renderModels();
          return true;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      mutations.set("modelLoadStatus", "error");
      updateModelLoadUi();
      addPersistentError(errorMessage(lastError, t("errors.couldNotLoadModels")), { key: "model-load" });
      return false;
    })().finally(() => {
      modelLoadPromise = null;
    });
    return modelLoadPromise;
  }
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
    const session = state.active?.id && state.sessionSettings.get(state.active.id),
      local = readLocalSessionModelSettings(),
      saved = local?.model || session?.model || storage.get(STORAGE_KEYS.model),
      selection = selectModelState(state.models, saved);
    mutations.set("selectedModel", selection.model);
    updateEfforts(
      local?.effort || session?.effort || session?.reasoningEffort || selection.effort,
      Boolean(local?.effort || session?.effort || session?.reasoningEffort),
    );
    syncModelLabel();
    renderModelMenuMain();
  }
  /** @param {string} threadId @param {{model?: string; reasoningEffort?: string; effort?: string; threadSettings?: {model?: string; effort?: string; reasoningEffort?: string}}} settings */
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
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      source: "session",
    });
    if (state.active?.id === threadId && state.models.length) {
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
    storage.set(STORAGE_KEYS.model, model);
    if (state.active?.id) {
      mutations.collection("sessionSettings").set(state.active.id, {
        ...(state.sessionSettings.get(state.active.id) || {}),
        model,
        effort: previous,
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
    const supported = model?.supportedReasoningEfforts || [{ reasoningEffort: "medium" }],
      values = supported.map((item) => item.reasoningEffort).filter(Boolean),
      local = readLocalSessionModelSettings(),
      saved =
        local?.model === state.selectedModel ? local?.effort : storage.get(STORAGE_KEYS.effortFor(state.selectedModel)),
      selected =
        [
          ...(preferPreferred ? [preferred, saved] : [saved, preferred]),
          model?.defaultReasoningEffort,
          values[0],
          "medium",
        ].find((value) => values.includes(value)) || "medium";
    for (const value of values.length ? values : ["medium"]) {
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
    return `<div class="model-menu-title-row">${back ? `<button type="button" class="model-menu-back" id="modelMenuBack" aria-label="Back" data-pf-aria-label="common.back">${codexIcon("chevronLeft")}</button>` : ""}<div class="model-menu-title">${messageHtml(text, undefined, t)}</div><button type="button" class="session-menu-close" ${messageAttributes("aria-label", "common.close", undefined, t)}>${codexIcon("x")}</button></div>`;
  }
  function renderModelMenuMain() {
    const menu = $("#modelMenu");
    if (!state.models.length) {
      setMessageHtml(
        menu,
        `${menuTitle("common.selectModel")}<div class="model-menu-title-row" role="status">${messageHtml(state.modelLoadStatus === "error" ? "errors.couldNotLoadModels" : "common.loadingModels", undefined, t)}</div>${state.modelLoadStatus === "error" ? `<button class="model-option" type="button" id="retryModels">${messageHtml("sessions.retryLoadingModels", undefined, t)}</button>` : ""}`,
      );
      findElement("#retryModels", menu)?.addEventListener("click", () => loadModels());
      return;
    }
    const model = selectedModel(),
      effort = $("#effortSelect");
    setMessageHtml(
      menu,
      `<div class="model-menu-view model-menu-view-main">${menuTitle("common.reasoning")}<div class="model-menu-list" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span><span data-pf-message="common.model">Model</span></span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon("chevronRight")}</button></div>`,
    );
    const list = requireElement("[data-model-menu-efforts]", menu);
    for (const option of effort.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-effort-row";
      button.role = "menuitemradio";
      button.dataset.value = option.value;
      button.setAttribute("aria-checked", String(option.selected));
      setMessageHtml(
        button,
        `<span>${escapeHtml(reasoningLabel(option.value))}</span><span class="model-check">${option.selected ? codexIcon("check") : ""}</span>`,
      );
      button.onclick = () => chooseEffort(option.value);
      list.append(button);
    }
    requireElement("#modelSubmenuButton", menu).onclick = renderModelSubmenu;
  }
  function renderModelSubmenu() {
    const menu = $("#modelMenu");
    setMessageHtml(
      menu,
      `<div class="model-menu-view model-menu-view-models">${menuTitle("common.model", true)}<div class="model-menu-list model-list"></div></div>`,
    );
    requireElement("#modelMenuBack", menu).onclick = renderModelMenuMain;
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
  function chooseEffort(value) {
    const effort = $("#effortSelect");
    if (![...effort.options].some((option) => option.value === value)) return;
    effort.value = value;
    setOpaqueText($("#effortLabel"), reasoningLabel(value));
    syncModelDescription();
    storage.set(STORAGE_KEYS.effortFor(state.selectedModel), value);
    if (state.active?.id) {
      mutations.collection("sessionSettings").set(state.active.id, {
        ...(state.sessionSettings.get(state.active.id) || {}),
        model: state.selectedModel,
        effort: value,
        source: "user",
      });
      writeLocalSessionModelSettings(state.active.id, { model: state.selectedModel, effort: value });
    }
    closeModelMenu();
    toast(t("common.reasoningLevel", { level: reasoningLabel(value) }));
  }
  function openModelMenu(view = "main") {
    closePermissionMenu();
    if (view === "models") renderModelSubmenu();
    else renderModelMenuMain();
    $("#modelMenu").hidden = false;
    $("#modelButton").setAttribute("aria-expanded", "true");
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
    $("#modelButton").setAttribute("aria-expanded", "false");
  }
  const permissionModes = {
    default: {
      kind: "legacy",
      label: "common.askForApproval",
      description: "common.alwaysAskForPermissionBeforeEditingExternalFilesOrUsing",
      icon: "shield",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    },
    "guardian-approvals": {
      kind: "legacy",
      label: "common.approveForMe",
      description: "common.onlyAskForActionsDetectedAsPotentiallyUnsafe",
      icon: "shield",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    },
    "full-access": {
      kind: "legacy",
      label: "common.fullAccess",
      description: "common.unrestrictedAccessToTheInternetAndAnyFileOnYour",
      icon: "terminal",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    },
  };
  const PERMISSION_PROFILE_PREFIX = "profile:";
  const RESERVED_PERMISSION_PROFILE_IDS = new Set(["default", "guardian-approvals", "full-access", "custom"]);
  function permissionProfileCwd() {
    if (state.projectless) return null;
    const path =
      state.active?.cwd ||
      state.workspaceContext?.cwd ||
      storage.get(STORAGE_KEYS.project) ||
      state.config.defaultCwd ||
      null;
    return typeof path === "string" && path.startsWith("~") ? state.config.home + path.slice(1) : path;
  }
  function permissionProfileId(mode = state.permissionMode) {
    return String(mode || "").startsWith(PERMISSION_PROFILE_PREFIX)
      ? String(mode).slice(PERMISSION_PROFILE_PREFIX.length)
      : null;
  }
  function autoReviewSupported() {
    return state.account?.type === "chatgpt";
  }
  function permissionModeDefinition(mode = state.permissionMode) {
    if (permissionModes[mode]) return { mode, ...permissionModes[mode] };
    const profileId = permissionProfileId(mode),
      profile = profileId && state.permissionProfiles.find((item) => item.id === profileId);
    return profile
      ? {
          kind: "profile",
          mode,
          profileId,
          label: profile.id,
          description: profile.description || "Custom permission profile",
          icon: "file",
          allowed: profile.allowed !== false,
        }
      : null;
  }
  function permissionModeAvailable(mode = state.permissionMode) {
    const selected = permissionModeDefinition(mode);
    if (!selected || selected.allowed === false) return false;
    if (mode === "guardian-approvals") return autoReviewSupported();
    if (mode === "full-access") return state.permissionVisibility.fullAccess;
    return true;
  }
  function normalizePermissionMode() {
    if (permissionModeAvailable()) return;
    mutations.set("permissionMode", "default");
    storage.set(STORAGE_KEYS.permissionMode, "default");
  }
  function selectedPermission() {
    normalizePermissionMode();
    return permissionModeDefinition() || { mode: "default", ...permissionModes.default };
  }
  /** @param {readonly import("../shared/engine/types.js").PermissionProfile[]} profiles */
  function setPermissionProfiles(profiles = []) {
    const seen = new Set();
    mutations.set(
      "permissionProfiles",
      (Array.isArray(profiles) ? profiles : []).flatMap((profile) => {
        if (!profile || typeof profile.id !== "string") return [];
        const id = profile.id.trim(),
          key = id.toLocaleLowerCase();
        if (!id || id.startsWith(":") || RESERVED_PERMISSION_PROFILE_IDS.has(key) || seen.has(key)) return [];
        seen.add(key);
        return [
          {
            id,
            description: typeof profile.description === "string" ? profile.description : "",
            allowed: profile.allowed !== false,
          },
        ];
      }),
    );
    normalizePermissionMode();
    syncPermissionControl();
  }
  async function loadPermissionProfiles() {
    if (!state.connected) return false;
    const requestId = permissionProfileRequestGate.next();
    try {
      const result = await rpc("permissionProfile/list", { cwd: permissionProfileCwd(), limit: 100 });
      if (permissionProfileRequestGate.isCurrent(requestId)) setPermissionProfiles(result.data || []);
      return permissionProfileRequestGate.isCurrent(requestId);
    } catch {
      if (permissionProfileRequestGate.isCurrent(requestId)) setPermissionProfiles([]);
      return false;
    }
  }
  function permissionThreadPolicy() {
    const selected = selectedPermission();
    if (selected.kind === "profile") return { permissions: selected.profileId };
    return {
      approvalPolicy: selected.approvalPolicy,
      approvalsReviewer: selected.approvalsReviewer,
      sandbox: selected.sandbox,
    };
  }
  function permissionTurnPolicy(cwd) {
    const selected = selectedPermission();
    if (selected.kind === "profile")
      return { permissions: selected.profileId, approvalPolicy: null, approvalsReviewer: null };
    const sandboxPolicy =
      selected.sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : {
            type: "workspaceWrite",
            writableRoots: cwd ? [cwd] : [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          };
    return {
      permissions: null,
      approvalPolicy: selected.approvalPolicy,
      approvalsReviewer: selected.approvalsReviewer,
      sandboxPolicy,
    };
  }
  function renderPermissionMenu() {
    const list = $("#permissionOptions");
    if (!list) return;
    setMessageHtml(list, "");
    const modes = ["default"];
    if (autoReviewSupported()) modes.push("guardian-approvals");
    if (state.permissionVisibility.fullAccess) modes.push("full-access");
    for (const profile of state.permissionProfiles) modes.push(`${PERMISSION_PROFILE_PREFIX}${profile.id}`);
    for (const mode of modes) {
      const option = permissionModeDefinition(mode);
      if (!option) continue;
      const checked = mode === state.permissionMode,
        button = document.createElement("button");
      button.type = "button";
      button.className = "permission-option";
      button.dataset.permissionMode = mode;
      button.role = "menuitemradio";
      button.disabled = option.allowed === false;
      button.setAttribute("aria-checked", String(checked));
      const description = option.allowed === false ? "Not allowed by managed settings" : option.description;
      setMessageHtml(
        button,
        `<span class="permission-option-icon">${codexIcon(option.icon)}</span><span class="permission-option-copy"><strong>${messageHtml(option.optionLabel || option.label, undefined, t)}</strong><small>${messageHtml(description, undefined, t)}</small></span><span class="permission-option-check">${checked ? codexIcon("check") : ""}</span>`,
      );
      button.onclick = () => choosePermissionMode(mode);
      list.append(button);
    }
  }
  function syncPermissionSettings() {
    const autoRow = $("#settingsAutoReviewRow"),
      autoToggle = $("#settingsAutoReviewToggle"),
      fullToggle = $("#settingsFullAccessToggle");
    if (autoRow) autoRow.hidden = true;
    if (autoToggle) autoToggle.checked = autoReviewSupported();
    if (fullToggle) fullToggle.checked = state.permissionVisibility.fullAccess;
    syncTaskNotifySettings();
  }
  function taskNotifyEnabled() {
    return storage.get(STORAGE_KEYS.taskNotify) !== "false";
  }
  function syncTaskNotifySettings() {
    const toggle = $("#settingsTaskNotifyToggle");
    if (toggle) {
      const available = "Notification" in window;
      toggle.checked =
        available &&
        (requestingNotificationPermission || (taskNotifyEnabled() && Notification.permission === "granted"));
      toggle.disabled = !available || requestingNotificationPermission;
      toggle.setAttribute("aria-busy", String(requestingNotificationPermission));
    }
  }
  async function setTaskNotifyEnabled(enabled) {
    if (requestingNotificationPermission) return;
    const on = Boolean(enabled);
    if (!on || !("Notification" in window)) {
      storage.set(STORAGE_KEYS.taskNotify, "false");
      syncTaskNotifySettings();
      return;
    }
    try {
      requestingNotificationPermission = Notification.permission === "default";
      syncTaskNotifySettings();
      // This path is called only by the user's notification toggle gesture.
      const permission = requestingNotificationPermission
        ? await Notification.requestPermission()
        : Notification.permission;
      storage.set(STORAGE_KEYS.taskNotify, String(permission === "granted"));
      if (permission === "denied") toast(t("sessions.browserNotificationsAreBlocked"));
    } catch {
      storage.set(STORAGE_KEYS.taskNotify, "false");
      toast(t("errors.couldNotEnableBrowserNotifications"));
    } finally {
      requestingNotificationPermission = false;
      syncTaskNotifySettings();
    }
  }
  function maybeNotifyTaskCompleted(p) {
    if (!taskNotifyEnabled()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.hasFocus() && !document.hidden) return;
    const thread = state.threads.find((x) => x.id === p.threadId),
      title = thread?.name || t("sessions.taskCompleted");
    try {
      new Notification(t("sessions.taskCompleted"), { body: title, tag: `codex-turn-${p.turn?.id || Date.now()}` });
    } catch {}
  }
  function syncPermissionControl() {
    normalizePermissionMode();
    const selected = selectedPermission();
    localizeText($("#modeButton .control-label"), state.planMode ? "common.planMode" : selected.label, undefined, t);
    for (const attribute of ["aria-label", "title"])
      localizeAttribute(
        $("#modeButton"),
        attribute,
        "common.permissionSetting",
        {
          mode: t(state.planMode ? "common.planMode" : selected.label),
        },
        t,
      );
    $("#modeButton").dataset.permissionMode = state.planMode ? "plan" : state.permissionMode;
    $("#modeButton").classList.toggle("active", state.planMode || state.permissionMode !== "default");
    if ($("#settingsPermissionValue")) localizeText($("#settingsPermissionValue"), selected.label, undefined, t);
    syncPermissionSettings();
    renderPermissionMenu();
  }
  function setPermissionMode(mode) {
    if (!permissionModeAvailable(mode)) return;
    const selected = permissionModeDefinition(mode);
    mutations.set("permissionMode", mode);
    storage.set(STORAGE_KEYS.permissionMode, mode);
    syncPermissionControl();
    closePermissionMenu();
    toast(t(selected.label));
  }
  function setPermissionVisibility(kind, enabled) {
    mutations.edit("permissionVisibility", (draft) => (draft[kind] = Boolean(enabled)));
    storage.set(
      kind === "autoReview" ? "panda-force-permission-auto-review" : STORAGE_KEYS.permissionFullAccess,
      String(Boolean(enabled)),
    );
    normalizePermissionMode();
    syncPermissionControl();
  }
  function openPermissionMenu() {
    closeModelMenu();
    syncPermissionControl();
    $("#permissionMenu").hidden = false;
    $("#modeButton").setAttribute("aria-expanded", "true");
    focusMenuSelection($("#permissionMenu"));
  }
  function closePermissionMenu() {
    const menu = $("#permissionMenu");
    menu.hidden = true;
    $("#modeButton").setAttribute("aria-expanded", "false");
  }
  function togglePermissionMenu() {
    if ($("#permissionMenu").hidden) openPermissionMenu();
    else closePermissionMenu();
  }
  function choosePermissionMode(mode) {
    closePermissionMenu();
    if (mode === "full-access" && state.permissionMode !== "full-access") {
      pendingFullAccessAction = "select";
      const dialog = $("#fullAccessDialog");
      if (!dialog.open) dialog.showModal();
      return;
    }
    setPermissionMode(mode);
  }
  /** @param {HTMLElement} menu */
  function focusMenuSelection(menu) {
    const close = findElement(".session-menu-close", menu);
    if (!close?.getClientRects().length) return;
    (findElement('[aria-checked="true"]', menu) || findElement("button:not(.session-menu-close)", menu) || close).focus(
      { preventScroll: true },
    );
  }
  /** @param {HTMLElement} menu @param {HTMLButtonElement} trigger @param {() => void} close */
  function bindMenuDismiss(menu, trigger, close) {
    const dismiss = () => {
      close();
      trigger.focus({ preventScroll: true });
    };
    menu.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".session-menu-close")) dismiss();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
  }
  bindMenuDismiss($("#modelMenu"), $("#modelButton"), closeModelMenu);
  bindMenuDismiss($("#permissionMenu"), $("#modeButton"), closePermissionMenu);
  $("#modelButton").addEventListener("click", toggleModelMenu);
  $("#modeButton").onclick = togglePermissionMenu;
  $("#confirmFullAccess").onclick = () => {
    const action = pendingFullAccessAction;
    $("#fullAccessDialog").close();
    if (action === "enable") setPermissionVisibility("fullAccess", true);
    else setPermissionMode("full-access");
    pendingFullAccessAction = "select";
  };
  $("#fullAccessDialog").addEventListener("close", () => {
    pendingFullAccessAction = "select";
    syncPermissionSettings();
  });
  $("#settingsAutoReviewToggle").onchange = (event) =>
    setPermissionVisibility("autoReview", event.currentTarget.checked);
  $("#settingsTaskNotifyToggle").onchange = (event) => setTaskNotifyEnabled(event.currentTarget.checked);
  $("#settingsFullAccessToggle").onchange = (event) => {
    if (!event.currentTarget.checked) {
      setPermissionVisibility("fullAccess", false);
      return;
    }
    event.currentTarget.checked = false;
    pendingFullAccessAction = "enable";
    const dialog = $("#fullAccessDialog");
    if (!dialog.open) dialog.showModal();
  };
  return {
    applySessionSettings,
    closeModelMenu,
    closePermissionMenu,
    commitSessionModelSettings,
    loadModels,
    loadPermissionProfiles,
    maybeNotifyTaskCompleted,
    modelDisplay,
    openModelMenu,
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
