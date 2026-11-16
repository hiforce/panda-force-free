import { knowledgeOriginalRuleHtml } from "./generation-original-view.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type {
  KnowledgeGenerationSourcePage,
  KnowledgeGenerationSelection,
  KnowledgeGenerationStatus,
} from "../../shared/knowledge/generation.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

export function knowledgeGenerationHtml(t: Translate) {
  return `<section class="knowledge-rules"><h3>${e(t("knowledge.rulesTitle"))}</h3><p>${e(t("knowledge.rulesHint"))}</p>
    <p data-rule-notice role="status"></p><p data-rule-availability hidden>${e(t("knowledge.rulesEngineRequired"))}</p><form class="wb-form" data-rule-form><fieldset data-rule-fields>
    <label class="wb-choice"><input type="checkbox" role="switch" name="pf-knowledge-rule-enabled"><span>${e(t("knowledge.rulesEnabled"))}</span></label><small>${e(t("knowledge.rulesEnabledHint"))}</small>
    <label class="wb-field"><span>${e(t("knowledge.purpose"))}</span><textarea name="pf-knowledge-rule-purpose" rows="3" maxlength="4096" placeholder="${e(t("knowledge.purposeHint"))}"></textarea></label>
    <section class="knowledge-rule-scope"><h3>${e(t("knowledge.sources"))}</h3>
    <label class="wb-choice"><input type="checkbox" name="pf-knowledge-rule-all"><span>${e(t("knowledge.rulesAll"))}</span></label>
    <p>${e(t("knowledge.rulesExclusionsWin"))}</p><p data-rule-summary></p>
    <details class="knowledge-rule-picker" data-rule-picker><summary><span>${e(t("knowledge.rulesChooseSources"))}</span>${codexIcon("chevronDown")}</summary><div class="resource-actions"><button type="button" class="wb-button" data-rule-clear>${e(t("knowledge.rulesClear"))}</button><button type="button" class="wb-button" data-rule-sources-reload>${e(t("knowledge.rulesReloadSources"))}</button></div>
    <p data-rule-page-notice role="status"></p><ul class="knowledge-rule-sources" data-rule-sources></ul>
    <div class="resource-actions"><button type="button" class="wb-button" data-rule-previous>${e(t("knowledge.rulesPrevious"))}</button><button type="button" class="wb-button" data-rule-next>${e(t("knowledge.rulesNext"))}</button></div></details></section>
    ${knowledgeOriginalRuleHtml(t)}
    <div class="knowledge-rule-limits"><label class="wb-field"><span>${e(t("knowledge.rulesDailyLimit"))}</span><input type="number" min="1" max="100" required name="pf-knowledge-rule-daily"></label><label class="wb-field"><span>${e(t("knowledge.rulesPendingLimit"))}</span><input type="number" min="1" max="16" required name="pf-knowledge-rule-pending"></label></div>
    <label class="wb-choice"><input type="checkbox" name="pf-knowledge-rule-backfill"><span>${e(t("knowledge.rulesBackfill"))}</span></label><small>${e(t("knowledge.rulesBackfillHint"))}</small>
    <p>${e(t("knowledge.rulesPauseHint"))}</p><p data-rule-preview-notice role="status">${e(t("knowledge.rulesPreviewHint"))}</p>
    <div class="resource-actions"><button type="button" class="wb-button" data-rule-preview>${e(t("knowledge.rulesPreview"))}</button><button type="submit" class="wb-button primary" data-rule-apply disabled>${e(t("knowledge.rulesApply"))}</button></div></fieldset><div class="resource-actions"><button type="button" class="wb-button" data-rule-reload>${e(t("knowledge.rulesReload"))}</button></div><small>${e(t("knowledge.rulesReloadHint"))}</small>
    </form><section class="knowledge-rule-progress"><header><h3>${e(t("knowledge.rulesProgress"))}</h3><button type="button" class="wb-button" data-rule-status-refresh>${e(t("knowledge.refresh"))}</button></header><div data-rule-status role="status"></div></section></section>`;
}
export function knowledgeRuleSourcesHtml(
  page: KnowledgeGenerationSourcePage,
  selection: KnowledgeGenerationSelection,
  t: Translate,
) {
  const choices = (id: string, title: string, exclude: boolean) => {
    const one = exclude ? "excludeDocuments" : "documents",
      tree = exclude ? "excludeSubtrees" : "subtrees",
      value = selection[tree].includes(id) ? "tree" : selection[one].includes(id) ? "document" : "none";
    return `<label class="wb-field"><span>${e(t(exclude ? "knowledge.rulesExclude" : "knowledge.rulesInclude"))}</span><select class="wb-select" data-rule-source="${exclude ? "exclude" : "include"}" data-rule-id="${e(id)}" aria-label="${e(t(exclude ? "knowledge.rulesExclude" : "knowledge.rulesInclude") + ": " + title)}">${[
      ["none", t(exclude ? "knowledge.rulesNone" : "knowledge.rulesDefault")],
      ["document", t("knowledge.rulesDocument")],
      ["tree", t("knowledge.rulesSubtree")],
    ]
      .map(([key, label]) => `<option value="${key}" ${key === value ? "selected" : ""}>${e(label!)}</option>`)
      .join("")}</select></label>`;
  };
  return page.documents
    .map(
      (d) =>
        `<li><strong data-i18n-ignore>${e(d.title)}</strong><small data-i18n-ignore>${e(d.space)}${d.breadcrumb ? " · " + e(d.breadcrumb) : ""}</small><div class="knowledge-rule-choices">${choices(d.id, d.title, false)}${choices(d.id, d.title, true)}</div></li>`,
    )
    .join("");
}
export function knowledgeRuleStatusHtml(status: KnowledgeGenerationStatus, t: Translate) {
  return `<p>${e(t(status.enabled ? "knowledge.rulesOn" : "knowledge.rulesOff"))}</p><p>${e(t("knowledge.rulesUsage", { used: status.dailyUsed, pending: status.pendingTasks }))}</p><p>${e(t("knowledge.rulesSharedBudget", { used: status.budget.ownerDailyUsed, daily: status.budget.limits.ownerDaily, pending: status.budget.ownerPending, pendingLimit: status.budget.limits.ownerPending }))}</p><p>${e(t("knowledge.rulesInstallationBudget", { daily: status.budget.limits.installationDaily, pending: status.budget.limits.installationPending }))}</p>${status.budget.blocked ? `<p>${e(t("knowledge.rulesBudgetHold"))}</p>` : ""}<p>${e(t("knowledge.rulesQueue", { queued: status.counts.queued, claimed: status.counts.claimed, failed: status.counts.failed }))}</p>${status.sourceUnavailable ? `<p>${e(t("knowledge.rulesSourceUnavailable"))}</p>` : ""}`;
}
