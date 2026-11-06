import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes, messageHtml, setMessageHtml, SUPPORTED_LOCALES } from "../i18n.js";
import { readThemePreference, THEME_OPTIONS } from "../theme.js";

/** Local outline glyphs match the existing 24-pixel icon grid. */
export function chromeIcon(kind) {
  const paths = {
    appearance:
      '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" opacity=".35"/>',
    fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    exitFullscreen: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
    width: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14m8-14v14"/>',
  };
  return paths[kind]
    ? `<span class="icon-slot"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg></span>`
    : codexIcon(kind);
}

export function createChromeView(t) {
  const toolbar = document.createElement("div");
  toolbar.className = "workbench-chrome";
  const controls = [
    ["search", "search", "common.searchAnything", "chrome-search"],
    ["language", "globe", "shell.language", "chrome-desktop"],
    ["appearance", "appearance", "shell.appearance", "chrome-desktop"],
    ["layout", "width", "shell.layout", "chrome-desktop"],
    ["fullscreen", "fullscreen", "shell.fullscreen", "chrome-fullscreen chrome-desktop"],
    ["preferences", "slidersHorizontal", "shell.preferences", "chrome-mobile"],
    ["profile", "userRound", "shell.profile", "chrome-profile chrome-desktop"],
  ];
  setMessageHtml(
    toolbar,
    controls
      .map(
        ([action, icon, key, className]) =>
          `<button type="button" class="chrome-control ${className}" data-chrome-menu="${action}" ${messageAttributes("aria-label", key, undefined, t)} ${messageAttributes("title", key, undefined, t)} ${["search", "fullscreen"].includes(action) ? "" : 'aria-haspopup="dialog" aria-controls="workbenchPreferences" aria-expanded="false"'}>${chromeIcon(icon)}<span class="chrome-control-label">${messageHtml(key, undefined, t)}</span></button>`,
      )
      .join(""),
  );
  const dialog = document.createElement("dialog");
  dialog.id = "workbenchPreferences";
  dialog.className = "workbench-preferences";
  dialog.setAttribute("aria-labelledby", "workbenchPreferencesTitle");
  document.body.append(dialog);
  return { toolbar, dialog };
}

/** @param {{ t: import('../../shared/i18n/messages.js').Translate; i18n: import('../contracts/platform.js').I18nRuntime; layout: import('../contracts/workbench-chrome.js').WorkbenchLayout; mobile: boolean; options: import('../contracts/workbench-chrome.js').WorkbenchChromeOptions }} context */
export function renderChromeMenu(menu, context) {
  const { t, i18n, layout, mobile, options } = context;
  const label = (key) => messageHtml(key, undefined, t);
  const option = (action, value, name, detail = "", leading = "", selected = false) =>
    `<button type="button" class="chrome-option${selected ? " selected" : ""}" data-chrome-action="${action}" data-value="${escapeHtml(value)}"${["locale", "theme", "width"].includes(action) ? ` aria-pressed="${selected}"` : ""}>${leading}<span class="chrome-option-copy"><strong>${name}</strong>${detail ? `<small>${detail}</small>` : ""}</span>${selected ? chromeIcon("check") : ""}</button>`;
  const localeName = () =>
    i18n.preference === "system"
      ? t("shell.followBrowser")
      : SUPPORTED_LOCALES.find((item) => item.code === i18n.preference)?.name || "English";
  let body = "";
  if (menu === "preferences") {
    body =
      option("menu", "language", label("shell.language"), escapeHtml(localeName()), chromeIcon("globe")) +
      option(
        "menu",
        "appearance",
        label("shell.appearance"),
        label(THEME_OPTIONS.find((item) => item.id === readThemePreference())?.labelKey || "common.systemDefault"),
        chromeIcon("appearance"),
      ) +
      option("menu", "layout", label("shell.layout"), "", chromeIcon("width")) +
      '<div class="chrome-menu-divider"></div>' +
      option("settings", "profile", label("shell.profile"), "", chromeIcon("userRound"));
  } else if (menu === "language") {
    body =
      `<p class="chrome-menu-hint">${label("shell.languageHint")}</p>` +
      option(
        "locale",
        "system",
        label("shell.followBrowser"),
        "",
        chromeIcon("monitor"),
        i18n.preference === "system",
      ) +
      SUPPORTED_LOCALES.map((locale) =>
        option(
          "locale",
          locale.code,
          escapeHtml(locale.name),
          "",
          `<span class="chrome-language-code" aria-hidden="true">${escapeHtml(locale.code === "en" ? "EN" : "中")}</span>`,
          i18n.preference === locale.code,
        ),
      ).join("");
  } else if (menu === "appearance") {
    body =
      `<p class="chrome-menu-hint">${label("shell.appearanceHint")}</p>` +
      THEME_OPTIONS.map((theme) =>
        option(
          "theme",
          theme.id,
          label(theme.labelKey),
          theme.id === "system" ? "" : label("shell." + (theme.id === "dark" ? "graphite" : theme.id) + "Hint"),
          theme.id === "system"
            ? chromeIcon("monitor")
            : `<span class="chrome-theme-swatch chrome-swatch-${theme.id}" aria-hidden="true"></span>`,
          readThemePreference() === theme.id,
        ),
      ).join("");
  } else if (menu === "layout") {
    const toggle = (panel, key, enabled, icon) =>
      `<button type="button" class="chrome-option" data-chrome-action="panel" data-value="${panel}" role="switch" aria-checked="${enabled}">${chromeIcon(icon)}<span class="chrome-option-copy"><strong>${label(key)}</strong></span><span class="chrome-switch${enabled ? " on" : ""}" aria-hidden="true"></span></button>`;
    if (!mobile) {
      body +=
        `<p class="chrome-menu-label">${label("shell.readingWidth")}</p>` +
        ["comfortable", "wide", "fill"]
          .map((width) =>
            option(
              "width",
              width,
              label("shell." + width),
              label("shell." + width + "Hint"),
              `<span class="chrome-width-preview ${width}" aria-hidden="true"></span>`,
              width === layout.readWidth(),
            ),
          )
          .join("") +
        '<div class="chrome-menu-divider"></div>';
    }
    body +=
      `<p class="chrome-menu-label">${label("shell.panels")}</p>` +
      toggle("navigation", "shell.navigation", options.readSidebar(), "panelLeft");
    if (options.hasSession()) body += toggle("details", "shell.sessionDetails", options.readDetails(), "panelRight");
    if (!mobile)
      body +=
        '<div class="chrome-menu-divider"></div>' +
        option(
          "focus",
          "",
          label(layout.isFocused() ? "shell.exitFocus" : "shell.focusMode"),
          label("shell.focusHint"),
          chromeIcon("columns2"),
          layout.isFocused(),
        );
    if (document.fullscreenEnabled)
      body += option(
        "fullscreen",
        "",
        label(document.fullscreenElement ? "shell.exitFullscreen" : "shell.browserFullscreen"),
        "",
        chromeIcon(document.fullscreenElement ? "exitFullscreen" : "fullscreen"),
      );
    body += option("restore", "", label("shell.restoreLayout"), "", chromeIcon("refreshCw"));
    body += `<p class="chrome-menu-hint chrome-menu-footnote">${label("shell.layoutHint")}</p>`;
  } else if (menu === "profile") {
    body =
      option("settings", "profile", label("shell.personalSettings"), "", chromeIcon("userRound")) +
      option("settings", "general-settings", label("common.settings"), "", chromeIcon("settings")) +
      option("settings", "keyboard-shortcuts", label("shell.keyboardShortcuts"), "", chromeIcon("command"));
  }
  const heading = menu === "preferences" ? "shell.preferences" : "shell." + menu;
  return `<header class="chrome-menu-heading">${mobile && menu !== "preferences" ? `<button type="button" class="chrome-menu-back" data-chrome-action="menu" data-value="preferences" ${messageAttributes("aria-label", "shell.preferences", undefined, t)}>${chromeIcon("arrowLeft")}</button>` : ""}<h2 id="workbenchPreferencesTitle" tabindex="-1">${label(heading)}</h2><button type="button" class="chrome-menu-close" data-chrome-action="close" ${messageAttributes("aria-label", "common.close", undefined, t)}>${chromeIcon("x")}</button></header><div class="chrome-menu-body">${body}</div>`;
}
