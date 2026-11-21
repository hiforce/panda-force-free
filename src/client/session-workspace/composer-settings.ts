import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { localizeAttribute, messageAttributes, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { escapeHtml } from "../../shared/html.js";
import { bindMenuDismiss, focusMenuSelection, mountSessionMenu, restoreSessionMenu } from "../session-controls/menu.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { SessionControlView } from "../contracts/session-workspace.js";

type Kind = "model" | "permissions";
export type ComposerSettingsNavigation = {
  flow: number;
  back: () => void;
  trigger: HTMLButtonElement;
};

/** The composer owns one entry; the existing domain controls retain their save and authorization rules. */
export function createComposerSettingsMenu(options: {
  t: Translate;
  read: () => SessionControlView;
  context: () => string;
  openDetail: (kind: Kind, navigation: ComposerSettingsNavigation) => void;
  beforeOpen: () => void;
}) {
  const { t } = options;
  const trigger = requireElement("#composerSettingsButton");
  const menu = document.createElement("div");
  menu.id = "composerSettingsMenu";
  menu.className = "composer-settings-menu composer-panel";
  menu.hidden = true;
  menu.role = "dialog";
  document.body.append(menu);
  let scope = "",
    signature = "",
    flow = 0;
  function labels() {
    const view = options.read(),
      model = view.models.find((item) => item.id === view.model);
    return {
      view,
      model:
        model?.label || t(view.modelLoadStatus === "error" ? "common.modelLoadFailedRetry" : "common.loadingModels"),
      effort: model?.efforts.find((item) => item.id === view.effort)?.label || "",
      permission:
        view.permissions.find((item) => item.id === view.permission)?.label ||
        t(view.permissionHint || "sessionview.permissionUnavailable"),
    };
  }
  function render() {
    const values = labels();
    const row = (kind: Kind, title: string, description: string, icon: string, disabled = false) =>
      `<button type="button" class="composer-settings-row" data-composer-setting="${kind}" ${disabled ? "disabled" : ""}>${codexIcon(icon)}<span><strong>${title}</strong><small>${escapeHtml(description)}</small></span>${codexIcon("chevronRight")}</button>`;
    localizeAttribute(menu, "aria-label", "composer.settings", undefined, t);
    setMessageHtml(
      menu,
      `<header class="composer-panel-heading"><h2>${messageHtml("composer.settings", undefined, t)}</h2><button type="button" class="session-menu-close composer-panel-action" ${messageAttributes("aria-label", "common.close", undefined, t)}>${codexIcon("x")}</button></header><div class="composer-settings-choices">${row("model", messageHtml("sessionview.modelReasoning", undefined, t), [values.model, values.effort].filter(Boolean).join(" · "), "slidersHorizontal")}${row("permissions", messageHtml("composer.executionPermissions", undefined, t), values.permission, "shield", !values.view.permissions.length)}</div>`,
    );
  }
  function close() {
    menu.hidden = true;
    restoreSessionMenu(menu);
    trigger.setAttribute("aria-expanded", "false");
  }
  function show() {
    if (scope !== options.context()) return close();
    options.beforeOpen();
    render();
    menu.hidden = false;
    mountSessionMenu(menu, trigger, close);
    trigger.setAttribute("aria-expanded", "true");
    focusMenuSelection(menu);
  }
  function open() {
    scope = options.context();
    flow++;
    show();
  }
  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-composer-setting]") : null;
    const kind = button?.dataset.composerSetting;
    if (!button || button.disabled || (kind !== "model" && kind !== "permissions")) return;
    if (scope !== options.context()) return close();
    close();
    options.openDetail(kind, { flow, back: () => requestAnimationFrame(show), trigger });
  });
  bindMenuDismiss(menu, trigger, close);
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !event.composedPath().includes(trigger) && !event.composedPath().includes(menu)) close();
  });
  function sync() {
    const values = labels();
    trigger.setAttribute("aria-busy", String(!values.view.models.length && values.view.modelLoadStatus === "loading"));
    setOpaqueText(requireElement("#composerSettingModel"), values.model.replace(/^GPT-/i, ""));
    setOpaqueText(requireElement("#composerSettingEffort"), values.effort);
    for (const attribute of ["aria-label", "title"])
      localizeAttribute(
        trigger,
        attribute,
        "composer.settingsSummary",
        { model: values.model, effort: values.effort },
        t,
      );
    const next = JSON.stringify([
      t("composer.settings"),
      values.model,
      values.effort,
      values.permission,
      values.view.permissions.length,
    ]);
    if (!menu.hidden) {
      if (scope !== options.context()) close();
      else if (signature !== next) {
        const selected = menu.contains(document.activeElement)
          ? (document.activeElement as HTMLElement).dataset.composerSetting
          : "";
        render();
        if (selected)
          menu
            .querySelector<HTMLButtonElement>(`[data-composer-setting="${selected}"]`)
            ?.focus({ preventScroll: true });
      }
    }
    signature = next;
  }
  sync();
  return { sync, close };
}
