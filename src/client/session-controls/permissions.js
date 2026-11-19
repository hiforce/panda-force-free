import { localizeAttribute, localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { createLatestRequestGate } from "../ui-core.js";
import { focusMenuSelection, bindMenuDismiss, mountSessionMenu, restoreSessionMenu } from "./menu.js";

/** Permission profiles, policy decisions and the full-access confirmation have one owner. */
export function createSessionPermissionControls({
  $,
  t,
  state,
  rpc,
  toast,
  mutations,
  onSettingsChanged,
  closeModelMenu,
  syncTaskNotifySettings,
}) {
  const permissionProfileRequestGate = createLatestRequestGate();
  let pendingFullAccessAction = "select",
    pendingFullAccessSession = "";
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
  /** @param {readonly import("../../shared/engine/types.js").PermissionProfile[]} profiles */
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
    onSettingsChanged();
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
    mountSessionMenu($("#permissionMenu"), $("#modeButton"), closePermissionMenu);
    $("#modeButton").setAttribute("aria-expanded", "true");
    focusMenuSelection($("#permissionMenu"));
  }
  function closePermissionMenu() {
    const menu = $("#permissionMenu");
    menu.hidden = true;
    restoreSessionMenu(menu);
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
  function permissionsView() {
    const modes = ["default"];
    if (autoReviewSupported()) modes.push("guardian-approvals");
    if (state.permissionVisibility.fullAccess) modes.push("full-access");
    modes.push(...state.permissionProfiles.map((profile) => `${PERMISSION_PROFILE_PREFIX}${profile.id}`));
    return modes
      .map((mode) => permissionModeDefinition(mode))
      .filter(Boolean)
      .map((option) => ({
        id: option.mode,
        label: option.kind === "profile" ? option.label : t(option.label),
        description: option.kind === "profile" ? option.description : t(option.description),
        allowed: permissionModeAvailable(option.mode),
      }));
  }
  $("#confirmFullAccess").onclick = () => {
    const action = pendingFullAccessAction,
      sessionId = pendingFullAccessSession;
    $("#fullAccessDialog").close();
    if (sessionId && state.active?.id !== sessionId) {
      toast(t("sessionview.sessionChanged"));
      return;
    }
    if (action === "enable") setPermissionVisibility("fullAccess", true);
    else setPermissionMode("full-access");
    pendingFullAccessAction = "select";
    pendingFullAccessSession = "";
  };
  $("#fullAccessDialog").addEventListener("close", () => {
    pendingFullAccessAction = "select";
    pendingFullAccessSession = "";
    syncPermissionSettings();
  });
  $("#settingsAutoReviewToggle").onchange = (event) =>
    setPermissionVisibility("autoReview", event.currentTarget.checked);
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
  function applyPermissionSelection(sessionId, mode) {
    if (!sessionId || state.active?.id !== sessionId) throw new Error(t("sessionview.sessionChanged"));
    if (!permissionModeAvailable(mode)) throw new Error(t("sessionview.permissionUnavailable"));
    choosePermissionMode(mode);
    if (mode === "full-access" && $("#fullAccessDialog").open) pendingFullAccessSession = sessionId;
  }
  bindMenuDismiss($("#permissionMenu"), $("#modeButton"), closePermissionMenu);
  $("#modeButton").onclick = togglePermissionMenu;
  return {
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
    permissionsView,
  };
}
