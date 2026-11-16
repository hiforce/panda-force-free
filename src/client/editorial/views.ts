import { escapeHtml as e } from "../../shared/html.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { EditorialDetail, RichTextEdit, EditorialSummary } from "../../shared/editorial/contracts.js";
import { messageHtml as m } from "../i18n.js";

const rules: Record<RichTextEdit["rule"], MessageId> = {
  repeatedSpaces: "editorial.repeatedSpaces",
  trailingWhitespace: "editorial.trailingWhitespace",
  spelling: "editorial.spelling",
  punctuation: "editorial.punctuation",
  grammar: "editorial.grammar",
  rewrite: "editorial.rewrite",
  translate: "editorial.translate",
};
export const reviewButton = (t: Translate, key: MessageId, action: string, primary = false) =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}" data-editorial-action="${action}">${m(key, undefined, t)}</button>`;
export function editorialFrame(t: Translate, title: string) {
  return `<header class="publishing-heading"><div><span>${m("editorial.workspace", undefined, t)}</span><h2 id="editorialTitle" data-i18n-ignore>${e(title)}</h2></div>${reviewButton(t, "documents.close", "close")}</header><div class="publishing-layout"><aside class="publishing-settings editorial-settings"><p>${m("editorial.scope", undefined, t)}</p>${reviewButton(t, "editorial.prepare", "prepare")}<label for="editorialHistory">${m("editorial.history", undefined, t)}</label><select id="editorialHistory"><option value="">${e(t("editorial.chooseHistory"))}</option></select><button type="button" class="wb-button editorial-more-history" data-editorial-action="more-history" hidden>${m("editorial.moreHistory", undefined, t)}</button><div id="editorialTaskWorkspace"></div></aside><section class="publishing-main"><p id="editorialStatus" role="status" aria-live="polite"></p><div id="editorialSuggestions"></div></section></div><footer class="publishing-footer"><p>${m("editorial.noChanges", undefined, t)}</p><div><span id="editorialSelected" aria-live="polite"></span>${reviewButton(t, "editorial.apply", "apply", true)}</div></footer>`;
}
export function suggestionView(t: Translate, detail: EditorialDetail) {
  const { proposal, receipt } = detail;
  const visible = (value: string) => e(value).replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\n", "↵");
  return `${receipt ? `<p class="editorial-state">${m("editorial.applied", { number: receipt.applied.version }, t)}</p>` : detail.stale ? `<p class="editorial-state">${m("editorial.staleNotice", undefined, t)}</p>` : ""}${receipt?.commit ? `<p class="editorial-commit">${m("editorial.savedVersion", undefined, t)} <code data-i18n-ignore>${e(receipt.commit)}</code></p>` : ""}${detail.pending && !receipt ? `<p class="editorial-state">${m("editorial.pendingApply", undefined, t)}</p>` : ""}<h3>${m("editorial.suggestionCount", { count: proposal.edits.length }, t)}</h3>${proposal.producer.kind === "model" ? `<p>${m("editorial.modelProducer", { model: proposal.producer.model }, t)}</p>` : ""}${proposal.truncated ? `<p>${m("editorial.truncated", undefined, t)}</p>` : ""}${proposal.edits.map((edit) => `<label class="editorial-suggestion"><input type="checkbox" data-editorial-edit="${e(edit.id)}" ${(receipt?.selected ?? detail.pending?.selected)?.includes(edit.id) ? "checked" : ""}><span><strong>${m(rules[edit.rule], undefined, t)}</strong><span class="editorial-context" data-i18n-ignore>${e(edit.contextBefore || "")}<mark>${visible(edit.before)}</mark>${e(edit.contextAfter || "")}</span><span class="editorial-diff"><del data-i18n-ignore>${visible(edit.before)}</del><span aria-hidden="true">→</span><ins data-i18n-ignore>${visible(edit.after) || "∅"}</ins></span>${edit.reason ? `<small data-i18n-ignore>${e(edit.reason)}</small>` : ""}</span></label>`).join("") || `<p>${m("editorial.noSuggestions", undefined, t)}</p>`}`;
}
export function editorialHistory(t: Translate, history: EditorialSummary[], selected: string) {
  return (
    `<option value="">${e(t("editorial.chooseHistory"))}</option>` +
    history
      .map(
        (review) =>
          `<option value="${e(review.id)}" ${selected === review.id ? "selected" : ""}>${e(new Date(review.createdAt).toLocaleString(document.documentElement.lang || "en"))} · ${e(t("documents.revision", { number: review.source.version }))}${review.applied ? ` · ${e(t("publishing.reviewed"))}` : ""}</option>`,
      )
      .join("")
  );
}
