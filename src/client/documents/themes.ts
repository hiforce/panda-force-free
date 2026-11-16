import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import { themeReference } from "../../shared/presentation/themes.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { presentationLabel } from "../presentation-labels.js";
import { styleCard } from "../publishing-styles/views.js";
import { styleReference } from "../publishing-styles/catalog.js";

export function themeOptions(t: Translate, themes: SiteThemeDescriptor[], selected: string) {
  const known = selected === "default" || themes.some((theme) => themeReference(theme) === selected);
  return `<option value="default" ${selected === "default" ? "selected" : ""}>${e(t("documents.themeDefault"))}</option>${!known ? `<option value="${e(selected)}" selected>${e(selected)} · ${e(t("documents.unknownTheme"))}</option>` : ""}${themes.map((theme) => `<option value="${e(themeReference(theme))}" ${selected === themeReference(theme) ? "selected" : ""}>${e(presentationLabel(t, theme))} · ${e(theme.version)} · ${e(theme.engine)}</option>`).join("")}`;
}
export function themeFields(t: Translate, themes: SiteThemeDescriptor[], selected: string) {
  return `<label for="doc-theme">${messageHtml("documents.theme", undefined, t)}</label><select id="doc-theme" name="document-theme" class="style-reference-select">${themeOptions(t, themes, selected)}</select><div class="styles-grid styles-choice-grid" id="documentThemeChoices"></div><p id="documentThemeDescription"></p><p>${messageHtml("documents.themeHint", undefined, t)}</p><a href="/settings/publishing-styles" target="_blank" rel="noopener">${e(t("plugins.stylesManage"))}</a>`;
}
export function describeTheme(host: HTMLElement, t: Translate, themes: SiteThemeDescriptor[]) {
  const reference = host.querySelector<HTMLSelectElement>("#doc-theme")!.value;
  const selected = themes.find((theme) => themeReference(theme) === reference);
  const choices = host.querySelector<HTMLElement>("#documentThemeChoices");
  if (choices) {
    // The select remains the single form value; cards only dispatch its normal change event.
    setMessageHtml(
      choices,
      `<button type="button" class="style-card style-default" data-style-reference="default" aria-pressed="${reference === "default"}">${e(t("documents.themeDefault"))}</button>` +
        themes
          .map((theme) => styleCard(t, { kind: "site", value: theme }, reference === themeReference(theme), "select"))
          .join(""),
    );
    choices.onclick = (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      if (!button || button.disabled) return;
      const next =
        button.dataset.styleReference ||
        themes
          .map((value) => ({ kind: "site" as const, value }))
          .find((item) => `site:${styleReference(item)}` === button.dataset.styleKey);
      const select = host.querySelector<HTMLSelectElement>("#doc-theme")!;
      select.value = typeof next === "string" ? next : next ? styleReference(next) : select.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
  }
  host.querySelector<HTMLElement>("#documentThemeDescription")!.textContent = selected
    ? presentationLabel(t, selected, "description")
    : t(reference === "default" ? "documents.themeDefault" : "documents.unknownTheme");
}
