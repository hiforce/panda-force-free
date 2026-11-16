import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { SourceStageView } from "../../shared/packages/stages/contracts.js";
import type { SourceSnapshotDescriptor } from "../../shared/packages/sources/snapshot.js";
import type { TemplateSourceInspection, TemplateSourceKind } from "../../shared/templates/sources/contracts.js";

export const sourceInProgress = (task: SourceStageView) =>
  ["uploading", "uploaded", "acquiring", "writing", "removing"].includes(task.state) ||
  (task.state === "reserved" && task.request.source.kind === "github");

export function sourceImportFrame(t: Translate) {
  return `<header><h2>${e(t("sources.import"))}</h2><button type="button" class="wb-button" data-source-action="close">${e(t("sources.close"))}</button></header>
  <div class="source-import-body"><p>${e(t("sources.importHint"))}</p><form class="wb-form" data-source-form>
  <label class="wb-field"><span>${e(t("sources.zip"))} / ${e(t("sources.github"))}</span><select data-source-kind><option value="zip-upload">${e(t("sources.zip"))}</option><option value="github">${e(t("sources.github"))}</option></select></label>
  <label class="wb-field" data-source-zip><span>${e(t("sources.file"))}</span><input type="file" accept=".zip,.potx,.pptx,application/zip,application/vnd.openxmlformats-officedocument.presentationml.template,application/vnd.openxmlformats-officedocument.presentationml.presentation" data-source-file></label>
  <div data-source-github hidden><label class="wb-field"><span>${e(t("sources.repository"))}</span><input data-source-repository autocomplete="off" spellcheck="false"></label>
  <div class="wb-form-grid"><label class="wb-field"><span>${e(t("sources.ref"))}</span><input data-source-ref autocomplete="off" spellcheck="false"></label><label class="wb-field"><span>${e(t("sources.root"))}</span><input data-source-root autocomplete="off" spellcheck="false"></label></div><p>${e(t("sources.publicGitHubOnly"))}</p></div>
  <button type="submit" class="wb-button primary" data-source-submit disabled>${e(t("sources.submit"))}</button><span role="status" data-source-notice></span>
  </form><section><header><h3>${e(t("sources.tasks"))}</h3><button type="button" class="wb-button" data-source-action="refresh">${e(t("sources.refresh"))}</button></header><p data-source-empty>${e(t("sources.empty"))}</p><div data-source-tasks></div></section><section data-source-inspection hidden></section></div>`;
}
export function sourceTaskFrame(t: Translate) {
  return `<div><strong data-source-name></strong><span data-source-status role="status"></span></div><p data-source-failure></p><p data-source-hint></p><div class="source-task-actions">${["resume", "inspect", "cancel", "remove"].map((action) => `<button type="button" class="wb-button${action === "remove" ? " danger" : ""}" data-source-action="${action}">${e(t(action === "resume" ? "sources.retryUpload" : `sources.${action as "inspect" | "cancel" | "remove"}`))}</button>`).join("")}</div>`;
}
const kindNames: Record<TemplateSourceKind, MessageId> = {
  "hexo-theme": "sources.hexoTheme",
  "hexo-site": "sources.hexoSite",
  "docusaurus-theme": "sources.docusaurusTheme",
  "docusaurus-site": "sources.docusaurusSite",
  "portable-library": "sources.portableLibrary",
  "powerpoint-template": "sources.powerpointTemplate",
  "powerpoint-bundle": "sources.powerpointBundle",
};
function candidateButton(t: Translate, kind: TemplateSourceKind, index: number) {
  const labels: Partial<Record<TemplateSourceKind, MessageId>> = {
    "portable-library": "sources.chooseLibrary",
    "hexo-theme": "templates.nativeConfigure",
    "docusaurus-theme": "templates.nativeConfigure",
    "powerpoint-template": "templates.officeConfigure",
    "powerpoint-bundle": "templates.officeConfigure",
  };
  const label = labels[kind];
  return label
    ? `<button type="button" class="wb-button" data-source-choose="${index}">${e(t(label))}</button>`
    : `<p>${e(t("sources.nativeInstallUnavailable"))}</p>`;
}
export function sourceInspection(t: Translate, value: TemplateSourceInspection) {
  const source = value.source;
  return `<h3>${e(t("sources.recognizedTemplates"))}</h3><p>${e(t("sources.notInstalled"))}</p><div class="source-candidates">${
    value.candidates.length
      ? value.candidates
          .map(
            (candidate, index) =>
              `<article data-source-candidate="${e(candidate.kind)}"><strong>${e(candidate.name)}</strong><span>${e(t(kindNames[candidate.kind]))}</span><code>${e(candidate.root || "/")}</code><details><summary>${e(t("sources.evidenceExamples"))}</summary>${candidate.evidence
                .slice(0, 6)
                .map((path) => `<code>${e(path)}</code>`)
                .join(
                  "",
                )}</details>${value.importableKinds.includes(candidate.kind) ? candidateButton(t, candidate.kind, index) : `<p>${e(t("sources.nativeInstallUnavailable"))}</p>`}</article>`,
          )
          .join("")
      : `<p>${e(t("sources.noCandidates"))}</p>`
  }</div>
  ${value.issues.map((issue) => `<p class="source-issue">${e(issue.path)}: ${e(t(`sources.${issue.code}`))}</p>`).join("")}
  <div data-source-template-review></div>
  <div data-source-native-review hidden></div>
  <div data-source-office-review hidden></div>
  <h3>${e(t("sources.files", { count: source.files.length }))}</h3><code class="source-fingerprint">${e(source.origin.kind === "github" ? source.origin.commit : source.origin.archiveSha256)}</code>
  <ul class="source-file-list"></ul><p data-source-file-count></p><button type="button" class="wb-button" data-source-more-files>${e(t("sources.moreFiles"))}</button>`;
}
export const sourceFileRows = (files: SourceSnapshotDescriptor["files"]) =>
  files.map((file) => `<li><code>${e(file.path)}</code><span>${file.bytes.toLocaleString()} B</span></li>`).join("");
