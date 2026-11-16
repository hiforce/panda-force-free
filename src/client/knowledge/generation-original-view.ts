import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SavedSourceSummary } from "../../shared/content-sources/catalog.js";
import type { KnowledgeGenerationOriginals } from "../../shared/knowledge/generation-originals.js";
import { escapeHtml as e } from "../../shared/html.js";

export function knowledgeOriginalRuleHtml(t: Translate) {
  const text = (id: MessageId) => e(t(id as never));
  return `<section class="knowledge-rule-scope" data-rule-native><h3>${text("knowledge.rulesOriginals")}</h3><label class="wb-choice"><input type="checkbox" data-native-enable><span>${text("knowledge.rulesOriginalsEnabled")}</span></label><small>${text("knowledge.rulesOriginalsHint")}</small><fieldset data-native-scope hidden><div class="resource-actions"><label class="wb-choice"><input type="checkbox" data-native-kind value="web"><span>${text("creative.web")}</span></label><label class="wb-choice"><input type="checkbox" data-native-kind value="slides"><span>${text("creative.slides")}</span></label></div><label class="wb-choice"><input type="checkbox" data-native-all><span>${text("knowledge.rulesOriginalsAll")}</span></label><p data-native-summary></p><details class="knowledge-rule-picker" data-native-picker><summary>${text("knowledge.rulesOriginalsChoose")}</summary><div class="resource-actions"><button type="button" class="wb-button" data-native-clear>${text("knowledge.rulesOriginalsClear")}</button><button type="button" class="wb-button" data-native-reload>${text("knowledge.rulesReloadSources")}</button></div><label class="wb-field"><span>${text("knowledge.sourceType")}</span><select data-native-browse></select></label><label class="wb-field"><span>${text("knowledge.sourceSearch")}</span><input type="search" maxlength="200" data-native-search></label><p role="status" data-native-notice></p><ul class="knowledge-rule-sources" data-native-sources></ul><p role="status" data-native-page></p><div class="resource-actions"><button type="button" class="wb-button" data-native-previous>${text("knowledge.sourcePrevious")}</button><button type="button" class="wb-button" data-native-next>${text("knowledge.sourceNext")}</button></div></details></fieldset></section>`;
}
export function knowledgeOriginalRows(
  rows: SavedSourceSummary[],
  rule: Pick<KnowledgeGenerationOriginals, "ids" | "exclude">,
  t: Translate,
) {
  return rows
    .map((row) => {
      const value = rule.exclude.includes(row.id) ? "exclude" : rule.ids.includes(row.id) ? "include" : "default";
      return `<li><strong data-i18n-ignore>${e(row.title)}</strong><label class="wb-field"><span>${e(t("knowledge.rulesOriginalPolicy"))}</span><select class="wb-select" data-native-choice="${e(row.id)}" aria-label="${e(t("knowledge.rulesOriginalPolicy") + ": " + row.title)}">${(
        [
          ["default", "knowledge.rulesOriginalDefault"],
          ["include", "knowledge.rulesInclude"],
          ["exclude", "knowledge.rulesExclude"],
        ] as const
      )
        .map(([id, label]) => `<option value="${id}" ${id === value ? "selected" : ""}>${e(t(label))}</option>`)
        .join("")}</select></label></li>`;
    })
    .join("");
}
