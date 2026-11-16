import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

/** Both user search and source diagnostics expose the same explicit query modes. */
export function searchModeField(t: Translate) {
  return `<label class="resource-field wb-field"><span>${e(t("search.queryMode"))}</span><select class="wb-select" name="pf-search-mode" data-search-mode><option value="text">${e(t("search.modeText"))}</option><option value="semantic">${e(t("search.modeSemantic"))}</option><option value="hybrid">${e(t("search.modeHybrid"))}</option></select></label>`;
}
