import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as message } from "../i18n.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { ContentIssue, ProofreadingSuggestion } from "../../shared/publishing/content.js";
import type { VariantDetail, VariantSummary } from "../../shared/publishing/variants.js";
import { publicationFormatLabels as labels } from "../publication-format-labels.js";
const templateLabels: Record<string, MessageId> = {
  editorial: "publishing.templateEditorial",
  technical: "publishing.templateTechnical",
  minimal: "publishing.templateMinimal",
};
export function button(t: Translate, label: MessageId, action: string, primary = false) {
  return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-pub-action="${action}">${message(label, undefined, t)}</button>`;
}
export function publishingFrame(t: Translate, title: string) {
  return `<header class="publishing-heading"><div><span>${message("publishing.workspace", undefined, t)}</span><h2 data-i18n-ignore>${e(title)}</h2></div>${button(t, "documents.close", "close")}</header>
    <div class="publishing-layout"><aside class="publishing-settings"><button type="button" class="wb-button publishing-settings-toggle" data-pub-action="settings" aria-expanded="true">${message("publishing.formatOptions", undefined, t)}</button><label for="publicationFormat">${message("publishing.format", undefined, t)}</label><select id="publicationFormat">${Object.entries(
      labels,
    )
      .map(([value, label]) => `<option value="${value}">${e(t(label))}</option>`)
      .join("")}</select>
    <label for="publicationTemplate">${message("publishing.template", undefined, t)}</label><select id="publicationTemplate" class="style-reference-select"></select><div class="styles-grid styles-choice-grid" id="publicationTemplateChoices"></div><a href="/settings/publishing-styles" target="_blank" rel="noopener">${message("plugins.stylesManage", undefined, t)}</a>
    <p id="publicationTemplateHint"></p><p>${message("publishing.formatHint", undefined, t)}</p>${button(t, "publishing.prepare", "prepare", true)}
    <label for="publicationHistory">${message("publishing.versions", undefined, t)}</label><select id="publicationHistory"><option value="">${e(t("publishing.chooseVersion"))}</option></select>
    <div class="publishing-proofread-link">${button(t, "publishing.proofread", "proofread")}<p>${message("publishing.proofreadHint", undefined, t)}</p></div></aside>
    <section class="publishing-main"><div id="publicationStatus" class="publishing-status" role="status"></div><div id="publicationVersionState"></div><div id="publicationIssues"></div><div id="publicationPreview" class="publishing-preview"><div class="publishing-empty">${message("publishing.startHint", undefined, t)}</div></div><div id="publicationProofread" hidden></div></section></div>
    <footer class="publishing-footer"><p>${message("publishing.noPublication", undefined, t)}</p><div id="publicationActions" hidden>${button(t, "publishing.copy", "copy")}${button(t, "publishing.exportHtml", "export-html")}${button(t, "publishing.exportText", "export-text")}${button(t, "publishing.exportBundle", "export-bundle")}${button(t, "publishing.markReviewed", "review", true)}${button(t, "social.open", "publish", true)}</div></footer>`;
}
export function historyOptions(t: Translate, versions: VariantSummary[], selected: string) {
  return (
    `<option value="">${e(t("publishing.chooseVersion"))}</option>` +
    versions
      .map(
        (v) =>
          `<option value="${e(v.id)}" ${v.id === selected ? "selected" : ""}>${e(t(labels[v.format]))} · ${e(templateLabels[v.templateId] ? t(templateLabels[v.templateId]!) : v.templateId)}${v.templateVersion ? ` @ ${e(v.templateVersion)}` : ""} · ${e(new Date(v.createdAt).toLocaleString())}</option>`,
      )
      .join("")
  );
}
const issueLabels: Record<ContentIssue["code"], MessageId> = {
  opaqueSyntax: "publishing.issueOpaque",
  unsafeLink: "publishing.issueUnsafeLink",
  unresolvedLink: "publishing.issueUnresolvedLink",
  externalImage: "publishing.issueExternalImage",
  unsupportedStyle: "publishing.issueStyle",
  structuredTextFlattened: "publishing.issueFlattened",
  splitIntoPosts: "publishing.issueThread",
  imageNeedsUpload: "publishing.issueMedia",
  articleMarkdownLimit: "publishing.issueMarkdownLimit",
  invalidPost: "publishing.issuePostLimit",
  postImageLimit: "publishing.issueImageLimit",
};
export function issueList(t: Translate, detail: VariantDetail) {
  if (!detail.variant.issues.length)
    return `<p class="publishing-valid">${message("publishing.noLosses", undefined, t)}</p>`;
  return `<details class="publishing-issues" open><summary>${message("publishing.conversionNotes", { count: detail.variant.issues.length }, t)}</summary>${detail.variant.issues.map((issue) => `<label class="publishing-issue" data-severity="${issue.severity}">${issue.severity === "warning" ? `<input type="checkbox" data-issue="${e(issue.blockId + ":" + issue.code)}" ${detail.review ? "checked" : ""}>` : `<span aria-hidden="true">${issue.severity === "blocking" ? "!" : "·"}</span>`}<span>${message(issueLabels[issue.code], undefined, t)}${/:b(\d+)$/.test(issue.blockId) ? `<small>${message("publishing.sourceBlock", { number: Number(issue.blockId.split(":b").pop()) }, t)}</small>` : ""}</span></label>`).join("")}</details>`;
}
export function postPreview(t: Translate, detail: VariantDetail) {
  return detail.variant.posts
    .map(
      (post, i) =>
        `<article class="publishing-post"><header><span>${i + 1} / ${detail.variant.posts.length}</span><span data-invalid="${!post.valid}">${post.weightedLength} / 280</span><button type="button" class="wb-button" data-pub-action="copy-post" data-index="${i}">${message("publishing.copy", undefined, t)}</button></header><pre data-i18n-ignore>${e(post.text)}</pre>${(
          post.imageIndexes || []
        )
          .map((index) => {
            const image = detail.variant.images?.[index];
            return image
              ? `<figure class="publishing-post-image">${/^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/i.test(image.source) ? `<img loading="lazy" src="${e(image.source)}" alt="${e(image.alt)}">` : ""}<figcaption data-i18n-ignore>${e(image.alt || image.source)}</figcaption></figure>`
              : "";
          })
          .join("")}</article>`,
    )
    .join("");
}
export function proofreadingView(t: Translate, suggestions: ProofreadingSuggestion[]) {
  return `<h3>${message("publishing.proofread", undefined, t)}</h3><p>${message("publishing.proofreadScope", undefined, t)}</p>${suggestions.length ? suggestions.map((s) => `<label class="publishing-suggestion"><input type="checkbox" data-suggestion="${e(s.id)}"><span><del data-i18n-ignore>${e(s.before).replaceAll(" ", "·")}</del><ins data-i18n-ignore>${e(s.after).replaceAll(" ", "·")}</ins></span></label>`).join("") + button(t, "publishing.applySuggestions", "apply-suggestions", true) : `<p>${message("publishing.noSuggestions", undefined, t)}</p>`}`;
}
