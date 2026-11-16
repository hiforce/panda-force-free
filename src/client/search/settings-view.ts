import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { SearchCatalog } from "./api.js";
import { searchModeField } from "./query-mode.js";
import { searchContentKindsHtml } from "./content-kinds.js";
import { searchConfigurationHtml } from "./configuration-view.js";
import { searchIndexSelectionHtml } from "./index-selection.js";
import { searchPolicyHistoryHtml } from "./policy-history.js";
import { vectorStorageHtml } from "./vector-storage-view.js";
export function searchSettingsHtml(c: SearchCatalog, projects: { id: string; name: string }[], t: Translate) {
  const label = (key: MessageId, control: string) =>
    `<label class="resource-field wb-field"><span>${e(t(key))}</span>${control}</label>`;
  return `<header class="resource-heading"><div><h1>${e(t("search.settingsTitle"))}</h1><p>${e(t("search.settingsHint"))}</p></div></header><p role="status" data-search-notice></p>${
    !c.administrator
      ? `<p>${e(t("search.managed"))}</p>`
      : `
  ${searchConfigurationHtml(c, t)}
  ${vectorStorageHtml(c, t)}
  <section class="search-settings-section"><h2>${e(t("search.indexAndTest"))}</h2><div class="search-field-grid">${label(
    "search.testSource",
    `<select class="wb-select" data-scope-source>${c.sources
      .filter((s) => s.enabled)
      .map((s) => `<option value="${e(s.id)}" ${s.id === c.binding.source ? "selected" : ""}>${e(s.name)}</option>`)
      .join("")}</select>`,
  )}${label("search.scope", `<select class="wb-select" data-scope-project><option value="personal">${e(t("creative.personal"))}</option>${projects.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join("")}</select>`)}</div><p data-scope-status role="status">${e(t("search.loading"))}</p><div data-index-progress></div><p data-embedding-usage role="status" hidden></p>${searchPolicyHistoryHtml(t)}<form class="search-form" data-index-form><fieldset disabled><label class="search-checkbox wb-choice"><input name="pf-search-enabled" type="checkbox"><span>${e(t("search.indexSavedContent"))}</span></label>${searchIndexSelectionHtml(t)}${searchContentKindsHtml(t)}${label("search.analyzer", `<select name="pf-search-analyzer" class="wb-select">${c.analyzers.map((a) => `<option value="${e(a.reference)}">${e(a.descriptor.name)} · ${e(a.reference)}</option>`).join("")}</select>`)}<details><summary>${e(t("search.pathRules"))}</summary><p>${e(t("search.pathRulesHint"))}</p><div class="search-field-grid">${label("search.includePaths", '<textarea name="pf-search-include" rows="3"></textarea>')}${label("search.excludePaths", '<textarea name="pf-search-exclude" rows="3"></textarea>')}</div></details><div class="resource-actions"><button type="submit" class="wb-button">${e(t("search.saveIndex"))}</button><button type="button" class="wb-button" data-index-rebuild>${e(t("search.rebuild"))}</button><button type="button" class="wb-button" data-index-preview>${e(t("search.previewScope"))}</button></div></fieldset></form><div data-index-preview-results></div><section class="search-integrity"><div class="resource-heading resource-section-heading"><h3>${e(t("search.auditTitle"))}</h3><button type="button" class="wb-button" data-index-audit disabled>${e(t("search.auditCheck"))}</button></div><div data-index-audit-report></div><p>${e(t("search.auditHint"))}</p></section><form class="content-search-form search-test-form" data-test-form>${label("search.testQuery", '<input name="pf-search-query" type="search" maxlength="300" required>')}${searchModeField(t)}<button type="submit" class="wb-button">${e(t("search.testSearch"))}</button></form><p class="search-mode-hint" data-search-mode-hint hidden>${e(t("search.semanticHint"))}</p><p>${e(t("search.testHint"))}</p><div class="content-search-results" data-test-results></div></section>
  <section class="search-settings-section"><h2>${e(t("search.languagePacks"))}</h2><p>${e(t("search.languageHint"))}</p><div class="search-analyzer-list">${c.analyzers.map((a) => `<article><div><strong data-i18n-ignore>${e(a.descriptor.name)}</strong><small data-i18n-ignore>${e(a.reference)} · ${e(a.descriptor.languages.join(", "))}</small></div><button class="wb-button" type="button" data-analyzer-export="${e(a.reference)}">${e(t("search.exportPack"))}</button></article>`).join("")}</div><div class="search-field-grid">${label("search.importPack", '<input type="file" data-analyzer-file accept=".json,.zip">')}<form class="search-form" data-analyzer-github><h3>GitHub</h3>${label("search.repository", '<input name="pf-search-repository" type="url" required placeholder="https://github.com/owner/repository">')}${label("search.reference", '<input name="pf-search-ref" type="text" maxlength="200" placeholder="main">')}${label("search.repositoryRoot", '<input name="pf-search-root" type="text" maxlength="300">')}<button class="wb-button" type="submit">${e(t("search.reviewPack"))}</button></form></div><div data-analyzer-review></div></section>`
  }`;
}
