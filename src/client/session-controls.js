import { createBridgeError } from "../shared/bridge-errors.js";
import { createLatestRequestGate, filterAppModels, selectModelState } from "./ui-core.js";
import { codexIcon } from "./codex-icons.js";
import { storage, STORAGE_KEYS } from "./storage.js";

/**
 * Session controls: model/effort selection with per-thread overrides, the
 * model and permission menus, permission profiles/policies, task-completed
 * notifications and the full-access confirmation dialog. Owns its control
 * DOM events; transport and app surfaces are injected.
 */
export function createSessionControls({ $, t, state, rpc, postBridge, escapeHtml, toast, addPersistentError }) {
  const permissionProfileRequestGate = createLatestRequestGate();
  let modelLoadPromise = null;
  let pendingFullAccessAction = "select";
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
    state.sessionSettings.set(threadId, {
      ...current,
      model: state.selectedModel,
      effort: $("#effortSelect").value,
      source: "remote",
    });
    clearLocalSessionModelSettings(threadId);
  }

  const reasoningLabels = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  function reasoningLabel(value) {
    return t(reasoningLabels[value] || String(value || "Medium"));
  }
  function updateModelLoadUi() {
    syncModelLabel();
    $("#modelButton").setAttribute("aria-busy", String(state.modelLoadStatus === "loading" && !state.models.length));
    if (!$("#modelMenu").hidden) renderModelMenuMain();
  }
  function loadModels({ timeoutMs = 8000, attempts = 3, retryDelayMs = 500 } = {}) {
    if (modelLoadPromise) return modelLoadPromise;
    state.modelLoadStatus = "loading";
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
            { id: state.rpcId++, method: "model/list", params: { limit: 50 } },
            controller.signal,
          );
          if (message.type !== "rpc/result")
            throw createBridgeError(message.error || "Could not load models", message.code);
          const models = filterAppModels(message.result?.data || []);
          if (!models.length) throw new Error("No models available");
          state.models = models;
          renderModels();
          return true;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      state.modelLoadStatus = "error";
      updateModelLoadUi();
      addPersistentError(lastError?.message || t("Could not load models"), { key: "model-load" });
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
    state.modelLoadStatus = "ready";
    $("#modelButton").setAttribute("aria-busy", "false");
    const session = state.active?.id && state.sessionSettings.get(state.active.id),
      local = readLocalSessionModelSettings(),
      saved = local?.model || session?.model || storage.get(STORAGE_KEYS.model),
      selection = selectModelState(state.models, saved);
    state.selectedModel = selection.model;
    updateEfforts(
      local?.effort || session?.effort || session?.reasoningEffort || selection.effort,
      Boolean(local?.effort || session?.effort || session?.reasoningEffort),
    );
    syncModelLabel();
    renderModelMenuMain();
  }
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
    state.sessionSettings.set(threadId, {
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
        state.selectedModel = local?.model || session.model;
      updateEfforts(local?.effort || session.effort, true);
      syncModelLabel();
      renderModelMenuMain();
    }
  }
  function chooseModel(model, keepOpen = false) {
    const previous = $("#effortSelect").value;
    state.selectedModel = model;
    storage.set(STORAGE_KEYS.model, model);
    if (state.active?.id) {
      state.sessionSettings.set(state.active.id, {
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
    toast(`Model: ${modelDisplay(selectedModel())}`);
  }
  function syncModelLabel() {
    const model = selectedModel();
    $("#modelLabel").textContent = state.models.length
      ? modelDisplay(model, true)
      : t(state.modelLoadStatus === "error" ? "Model load failed · Retry" : "Loading models…");
    $("#effortLabel").textContent = reasoningLabel($("#effortSelect").value);
  }
  function updateEfforts(preferred, preferPreferred = false) {
    const model = selectedModel(),
      effort = $("#effortSelect");
    effort.innerHTML = "";
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
      option.textContent = value;
      option.selected = value === selected;
      effort.append(option);
    }
    $("#effortLabel").textContent = reasoningLabel(effort.value);
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
      windowThousands = Math.round(usage.contextWindow / 1000),
      status = rounded >= 50 ? `${rounded}% full` : `${rounded}% used (${remaining}% left)`;
    indicator.hidden = false;
    indicator.style.setProperty("--context-percent", String(percent));
    indicator.setAttribute("aria-label", `Context usage: ${rounded}%`);
    indicator.dataset.tooltip = `Context window:\n${status}\n${usedThousands}k / ${windowThousands}k tokens used`;
  }
  function menuTitle(text, back = false) {
    return `<div class="model-menu-title-row">${back ? `<button type="button" class="model-menu-back" id="modelMenuBack" aria-label="Back">${codexIcon("chevronLeft")}</button>` : ""}<div class="model-menu-title">${escapeHtml(text)}</div></div>`;
  }
  function renderModelMenuMain() {
    const menu = $("#modelMenu");
    if (!state.models.length) {
      menu.innerHTML = `<div class="model-menu-title-row" role="status">${escapeHtml(t(state.modelLoadStatus === "error" ? "Could not load models" : "Loading models…"))}</div>${state.modelLoadStatus === "error" ? `<button class="model-option" type="button" id="retryModels">${escapeHtml(t("Retry loading models"))}</button>` : ""}`;
      menu.querySelector("#retryModels")?.addEventListener("click", () => loadModels());
      return;
    }
    const model = selectedModel(),
      effort = $("#effortSelect");
    menu.innerHTML = `<div class="model-menu-view model-menu-view-main">${menuTitle("Reasoning")}<div class="model-menu-list" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span>Model</span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon("chevronRight")}</button></div>`;
    const list = menu.querySelector("[data-model-menu-efforts]");
    for (const option of effort.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-effort-row";
      button.dataset.value = option.value;
      button.setAttribute("aria-checked", String(option.selected));
      button.innerHTML = `<span>${escapeHtml(reasoningLabel(option.value))}</span><span class="model-check">${option.selected ? codexIcon("check") : ""}</span>`;
      button.onclick = () => chooseEffort(option.value);
      list.append(button);
    }
    menu.querySelector("#modelSubmenuButton").onclick = renderModelSubmenu;
  }
  function renderModelSubmenu() {
    const menu = $("#modelMenu");
    menu.innerHTML = `<div class="model-menu-view model-menu-view-models">${menuTitle("Model", true)}<div class="model-menu-list model-list"></div></div>`;
    menu.querySelector("#modelMenuBack").onclick = renderModelMenuMain;
    const list = menu.querySelector(".model-list");
    for (const model of state.models) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-option";
      button.role = "menuitemradio";
      button.dataset.model = model.model;
      button.setAttribute("aria-checked", String(model.model === state.selectedModel));
      button.innerHTML = `<span class="model-option-copy"><strong>${escapeHtml(modelDisplay(model))}</strong>${model.description ? `<small>${escapeHtml(model.description)}</small>` : ""}</span><span class="model-check">${model.model === state.selectedModel ? codexIcon("check") : ""}</span>`;
      button.onclick = () => chooseModel(model.model);
      list.append(button);
    }
  }
  function chooseEffort(value) {
    const effort = $("#effortSelect");
    if (![...effort.options].some((option) => option.value === value)) return;
    effort.value = value;
    $("#effortLabel").textContent = reasoningLabel(value);
    storage.set(STORAGE_KEYS.effortFor(state.selectedModel), value);
    if (state.active?.id) {
      state.sessionSettings.set(state.active.id, {
        ...(state.sessionSettings.get(state.active.id) || {}),
        model: state.selectedModel,
        effort: value,
        source: "user",
      });
      writeLocalSessionModelSettings(state.active.id, { model: state.selectedModel, effort: value });
    }
    closeModelMenu();
    toast(`Reasoning: ${reasoningLabel(value)}`);
  }
  function openModelMenu(view = "main") {
    if (view === "models") renderModelSubmenu();
    else renderModelMenuMain();
    $("#modelMenu").hidden = false;
    $("#modelButton").setAttribute("aria-expanded", "true");
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
      label: "Ask for approval",
      description: "Always ask for permission before editing external files or using the internet",
      icon: "shield",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    },
    "guardian-approvals": {
      kind: "legacy",
      label: "Approve for me",
      description: "Only ask for actions detected as potentially unsafe",
      icon: "shield",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    },
    "full-access": {
      kind: "legacy",
      label: "Full access",
      description: "Unrestricted access to the internet and any file on your computer",
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
    state.permissionMode = "default";
    storage.set(STORAGE_KEYS.permissionMode, "default");
  }
  function selectedPermission() {
    normalizePermissionMode();
    return permissionModeDefinition() || { mode: "default", ...permissionModes.default };
  }
  function setPermissionProfiles(profiles = []) {
    const seen = new Set();
    state.permissionProfiles = (Array.isArray(profiles) ? profiles : []).flatMap((profile) => {
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
    });
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
    list.innerHTML = "";
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
      button.innerHTML = `<span class="permission-option-icon">${codexIcon(option.icon)}</span><span class="permission-option-copy"><strong>${escapeHtml(option.optionLabel || option.label)}</strong><small>${escapeHtml(description)}</small></span><span class="permission-option-check">${checked ? codexIcon("check") : ""}</span>`;
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
      toggle.checked = available && taskNotifyEnabled() && Notification.permission !== "denied";
      toggle.disabled = !available;
    }
  }
  async function setTaskNotifyEnabled(enabled) {
    const on = Boolean(enabled);
    storage.set(STORAGE_KEYS.taskNotify, String(on));
    if (on && "Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    syncTaskNotifySettings();
    if (on && "Notification" in window && Notification.permission === "denied")
      toast(t("Browser notifications are blocked"));
  }
  function maybeNotifyTaskCompleted(p) {
    if (!taskNotifyEnabled()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.hasFocus() && !document.hidden) return;
    const thread = state.threads.find((x) => x.id === p.threadId),
      title = thread?.name || t("Task completed");
    try {
      new Notification(t("Task completed"), { body: title, tag: `codex-turn-${p.turn?.id || Date.now()}` });
    } catch {}
  }
  function requestTaskNotifyPermission() {
    if (taskNotifyEnabled() && "Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
  }
  function syncPermissionControl() {
    normalizePermissionMode();
    const selected = selectedPermission();
    $("#modeButton .control-label").textContent = t(state.planMode ? "Plan mode" : selected.label);
    $("#modeButton").classList.toggle("active", state.planMode || state.permissionMode !== "default");
    if ($("#settingsPermissionValue")) $("#settingsPermissionValue").textContent = t(selected.label);
    syncPermissionSettings();
    renderPermissionMenu();
  }
  function setPermissionMode(mode) {
    if (!permissionModeAvailable(mode)) return;
    const selected = permissionModeDefinition(mode);
    state.permissionMode = mode;
    storage.set(STORAGE_KEYS.permissionMode, mode);
    syncPermissionControl();
    closePermissionMenu();
    toast(selected.label);
  }
  function setPermissionVisibility(kind, enabled) {
    state.permissionVisibility[kind] = Boolean(enabled);
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
    requestTaskNotifyPermission,
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
