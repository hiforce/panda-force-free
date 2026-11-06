import { closestElement, findElement, findElements, requireElement } from "../dom.js";
import { applyThemePreference } from "../theme.js";
import { localizeAttribute, setMessageHtml } from "../i18n.js";
import { createWorkbenchLayout } from "./layout.js";
import { chromeIcon, createChromeView, renderChromeMenu } from "./view.js";

/** Global preferences operate on existing feature owners, never on session state. */
/** @param {import('../contracts/workbench-chrome.js').WorkbenchChromeOptions} options */
export function createWorkbenchChrome(options) {
  const { t, i18n } = options;
  const { toolbar, dialog } = createChromeView(t);
  const layout = createWorkbenchLayout(options);
  requireElement(".top-actions").append(toolbar);
  const exitFocus = requireElement("#workbenchExitFocus");
  const mobile = matchMedia("(max-width: 767px)");
  let menu = "",
    generation = 0,
    bound = false;
  /** @type {HTMLElement | null} */
  let trigger = null;
  function position() {
    if (!dialog.open || mobile.matches || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    dialog.style.left = `${Math.max(12, Math.min(rect.right - dialog.offsetWidth, innerWidth - dialog.offsetWidth - 12))}px`;
    dialog.style.top = `${rect.bottom + 12}px`;
  }
  function render() {
    if (!menu) return;
    setMessageHtml(dialog, renderChromeMenu(menu, { t, i18n, layout, mobile: mobile.matches, options }));
    position();
  }
  function close(restore = true) {
    generation++;
    menu = "";
    if (dialog.open) dialog.close();
    trigger?.setAttribute("aria-expanded", "false");
    if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  function open(next, anchor = trigger) {
    if (!["language", "appearance", "layout", "preferences", "profile"].includes(next)) return;
    generation++;
    trigger?.setAttribute("aria-expanded", "false");
    trigger = anchor;
    menu = next;
    render();
    if (!dialog.open) {
      if (mobile.matches) dialog.showModal();
      else dialog.show();
    }
    trigger?.setAttribute("aria-expanded", "true");
    position();
    (findElement('button[aria-pressed="true"]', dialog) || requireElement("h2", dialog)).focus({ preventScroll: true });
  }
  function refresh() {
    exitFocus.hidden = !layout.isFocused();
    const full = requireElement('[data-chrome-menu="fullscreen"]', toolbar);
    full.hidden = !document.fullscreenEnabled;
    const key = document.fullscreenElement ? "shell.exitFullscreen" : "shell.fullscreen";
    localizeAttribute(full, "aria-label", key);
    localizeAttribute(full, "title", key);
    setMessageHtml(full, chromeIcon(document.fullscreenElement ? "exitFullscreen" : "fullscreen"));
    // Never replace an open menu during unrelated background session refreshes.
  }
  async function fullscreen() {
    close(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      options.onError(t("shell.fullscreenUnavailable"));
    }
    refresh();
  }
  async function action(event) {
    const button = closestElement("button[data-chrome-action]", event.target);
    if (!button) return;
    const { chromeAction: kind, value = "" } = button.dataset;
    if (kind === "menu") open(value);
    else if (kind === "close") close();
    else if (kind === "locale") {
      const request = generation;
      button.disabled = true;
      try {
        await i18n.setPreference(value);
        if (generation === request) close();
      } catch {
        options.onError(t("shell.languageFailed"));
        if (generation === request) render();
      }
    } else if (kind === "theme") {
      applyThemePreference(value);
      close();
    } else if (kind === "width") {
      layout.setWidth(value);
      close();
    } else if (kind === "panel") {
      close(false);
      if (value === "navigation") layout.setPanel(value, !options.readSidebar());
      else if (value === "details") layout.setPanel(value, !options.readDetails());
      refresh();
    } else if (kind === "focus") {
      close(false);
      layout.setFocus(!layout.isFocused());
      refresh();
      if (!exitFocus.hidden) exitFocus.focus();
    } else if (kind === "restore") {
      close();
      layout.setFocus(false);
      layout.setWidth("comfortable");
      layout.setPanel("navigation", !mobile.matches);
      if (options.hasSession()) layout.setPanel("details", matchMedia("(min-width:1081px)").matches);
      refresh();
    } else if (kind === "fullscreen") await fullscreen();
    else if (kind === "settings") {
      close(false);
      options.openSettings(value);
    }
  }
  function outside(event) {
    if (!menu || !(event.target instanceof Node) || dialog.contains(event.target) || toolbar.contains(event.target))
      return;
    close(false);
  }
  function keydown(event) {
    if (!menu) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (dialog.contains(event.target) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = findElements("button:not(:disabled)", dialog);
      const index = buttons.findIndex((button) => button === document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    toolbar.addEventListener("click", (event) => {
      const button = closestElement("[data-chrome-menu]", event.target);
      if (!button) return;
      const next = button.dataset.chromeMenu;
      if (next === "search") {
        close(false);
        options.openSearch();
      } else if (next === "fullscreen") void fullscreen();
      else if (menu === next) close();
      else open(next, button);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      } else void action(event);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("fullscreenchange", refresh);
    addEventListener("resize", position);
    addEventListener("panda-force:appearance-changed", refresh);
    mobile.addEventListener("change", () => {
      close(false);
      layout.reconcileViewport();
      refresh();
    });
    i18n.subscribe(() => {
      refresh();
      render();
    });
    exitFocus.onclick = () => {
      layout.setFocus(false);
      refresh();
    };
    refresh();
  }
  return { bind, refresh };
}
