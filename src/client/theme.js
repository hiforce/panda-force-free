import { findElement } from "./dom.js";
import { storage } from "./storage.js";

/** @typedef {"system" | "light" | "dark" | "silk" | "aurora"} ThemePreference */
export const THEME_KEY = "panda-force-theme";
/** @type {ReadonlyArray<{ id: ThemePreference; labelKey: import("../shared/i18n/messages.js").MessageId }>} */
export const THEME_OPTIONS = Object.freeze([
  { id: "system", labelKey: "common.systemDefault" },
  { id: "light", labelKey: "common.light" },
  { id: "dark", labelKey: "shell.graphite" },
  { id: "silk", labelKey: "shell.silk" },
  { id: "aurora", labelKey: "shell.aurora" },
]);

/** Presets share one preference; color scheme stays compatible with native tools.
 * @param {unknown} value
 * @param {boolean} systemDark
 */
export function resolveThemePreference(value, systemDark) {
  const preference = THEME_OPTIONS.find((option) => option.id === value)?.id || "system";
  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  return {
    preference,
    theme: resolved === "dark" || resolved === "aurora" ? "dark" : "light",
    appearance: resolved === "dark" ? "graphite" : resolved,
    chrome: { light: "#ffffff", dark: "#181a1d", silk: "#fcfaf7", aurora: "#071423" }[resolved],
  };
}

export function readThemePreference() {
  return resolveThemePreference(storage.get(THEME_KEY), false).preference;
}

/** @param {unknown} [value] */
export function applyThemePreference(value = readThemePreference()) {
  const appearance = resolveThemePreference(value, matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.appearance = appearance.appearance;
  document.documentElement.style.colorScheme = appearance.theme;
  storage.set(THEME_KEY, appearance.preference);
  findElement('meta[name="theme-color"]')?.setAttribute("content", appearance.chrome);
  const select = findElement("#themeSelect");
  if (select) select.value = appearance.preference;
  window.dispatchEvent(new CustomEvent("panda-force:appearance-changed", { detail: appearance }));
  return appearance.preference;
}
