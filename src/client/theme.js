import { storage } from "./storage.js";
export const THEME_KEY = "panda-force-theme";
export function applyThemePreference(value = storage.get(THEME_KEY) || "system") {
  const preference = ["light", "dark", "system"].includes(value) ? value : "system";
  const theme =
    preference === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  storage.set(THEME_KEY, preference);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#161b24" : "#f7f8fa");
  const select = document.querySelector("#themeSelect");
  if (select) select.value = preference;
  return preference;
}
