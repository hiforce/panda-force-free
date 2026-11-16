import { managedCover } from "./covers.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { isPublishingTemplate, publishingTemplateTypes, type TemplateDomain } from "../../shared/templates/domain.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { presentationLabel } from "../presentation-labels.js";
import { publicationFormatLabels } from "../publication-format-labels.js";
import type { SkillOutput } from "../../shared/skills/contracts.js";
import { codexIcon } from "../codex-icons.js";
import { messageHtml as m, messageAttributes as a } from "../i18n.js";

const typeNames: Record<string, MessageId> = {
  "panda.site-theme": "templates.site",
  "panda.channel-format": "templates.channel",
  "panda.document-template": "templates.document",
  "panda.slides-template": "templates.slides",
  "panda.creation-style": "templates.style",
  "panda.creation-template": "templates.creation",
  "panda.creation-workflow": "templates.workflow",
};
export const templateTypeName = (t: Translate, item: ManagedTemplate) =>
  typeNames[item.templateType] ? t(typeNames[item.templateType]!) : item.templateType;
export function templateState(t: Translate, item: ManagedTemplate) {
  return t(
    item.state.removed
      ? "templates.removed"
      : !item.state.enabled
        ? "plugins.disabled"
        : item.state.active
          ? "templates.defaultVersion"
          : "templates.retainedVersion",
  );
}
export function managerFrame(t: Translate, domain?: TemplateDomain) {
  const search = domain === "publishing" ? "templates.resourceSearch" : "templates.search";
  const option = (value: string, id: MessageId) =>
    `<option value="${e(value)}" data-pf-message="${e(id)}">${e(t(id))}</option>`;
  return `<header class="resource-heading template-manager-heading"><div><h1>${m("templates.title", undefined, t)}</h1><p>${m("templates.subtitle", undefined, t)}</p></div><div class="resource-actions"><button type="button" class="wb-button primary" data-template-action="article">${m("templates.newArticleTemplate", undefined, t)}</button><button type="button" class="wb-button template-import-button" data-template-action="import" ${a("aria-label", "templates.import", undefined, t)} ${a("title", "templates.import", undefined, t)}>${codexIcon("fileInput")}<span class="template-import-label">${m("templates.import", undefined, t)}</span></button><details class="resource-menu" data-template-menu><summary class="wb-button" ${a("aria-label", "templates.moreActions", undefined, t)}>${codexIcon("ellipsis")}</summary><div class="resource-menu-items"><button type="button" data-template-action="source-import">${m("sources.import", undefined, t)}</button><button type="button" data-template-action="article-drafts">${m("templates.articleDrafts", undefined, t)}</button><button type="button" data-template-action="drafts">${m("templates.publishingDrafts", undefined, t)}</button></div></details></div><span role="status" data-template-creation-notice></span></header>
    <div class="skills-gallery-tools" data-template-workspace-tools hidden></div><div class="template-filters"><input type="search" data-template-search ${a("placeholder", search, undefined, t)} ${a("aria-label", search, undefined, t)}><select class="wb-select" data-template-type ${a("aria-label", domain === "publishing" ? "templates.resourceType" : "templates.type", undefined, t)}>${option("", "templates.allTypes")}${Object.entries(
      typeNames,
    )
      .filter(([value]) => !domain || publishingTemplateTypes.includes(value) === (domain === "publishing"))
      .map(([value, id]) => option(value, id))
      .join(
        "",
      )}</select><select class="wb-select" data-template-state ${a("aria-label", "templates.state", undefined, t)}>${option("all", "templates.allStates")}${option("enabled", "plugins.enabled")}${option("disabled", "plugins.disabled")}${option("removed", "templates.removed")}</select><button type="button" class="wb-button template-refresh-button" data-template-action="refresh" ${a("aria-label", "plugins.refresh", undefined, t)} ${a("title", "plugins.refresh", undefined, t)}>${codexIcon("refreshCw")}</button></div>
    <p class="styles-notice" role="status" data-template-notice></p><div class="template-grid" data-template-grid></div><footer class="template-page-footer"><span data-template-total></span><button type="button" class="wb-button" data-template-action="more" hidden>${m("templates.loadMore", undefined, t)}</button></footer>`;
}
export function managerEmpty(t: Translate, filtered: boolean, domain?: TemplateDomain) {
  const publishing = domain === "publishing";
  return `<div class="resource-empty template-empty">${codexIcon(filtered ? "search" : "layout")}<h2>${m(publishing ? (filtered ? "templates.resourceEmpty" : "templates.resourceEmptyLibrary") : filtered ? "templates.empty" : "templates.emptyLibrary", undefined, t)}</h2><p>${m(publishing ? (filtered ? "templates.resourceEmptyFilterHint" : "templates.resourceEmptyHint") : filtered ? "templates.emptyFilterHint" : "templates.emptyLibraryHint", undefined, t)}</p>${filtered ? `<button type="button" class="wb-button" data-template-action="clear-filters">${m("templates.clearFilters", undefined, t)}</button>` : ""}</div>`;
}
export function managerCard(t: Translate, item: ManagedTemplate, pinned?: boolean) {
  const state = templateState(t, item),
    label = presentationLabel(t, item.label),
    author = item.publisher || t("templates.notDeclared"),
    initial = Array.from(author.trim())[0] || "",
    exceptional = !item.state.enabled || !item.state.active || item.state.removed;
  const card = `<button type="button" class="template-card" data-template-action="detail" data-template-key="${e(item.key)}" title="${e(label)}">${managedCover(item)}<span class="template-card-body"><strong>${e(label)}</strong><span class="template-card-description">${e(presentationLabel(t, item.label, "description"))}</span><small class="template-card-attribution"><span class="template-card-author" title="${e(author)}"><span class="template-author-mark" aria-hidden="true">${e(initial)}</span><span>${e(author)}</span></span><span class="template-state" data-enabled="${item.state.enabled}" aria-label="${e(state + " · " + item.reference.version)}" title="${e(state + " · " + item.reference.version)}"><span class="template-card-version">v${e(item.reference.version)}</span></span></small>${exceptional ? `<span class="template-card-status">${e(state)}</span>` : ""}</span></button>`;
  return pinned === undefined
    ? card
    : `<article class="template-card-shell">${card}<button type="button" class="skills-card-pin icon-button" data-template-action="pin" data-skills-pin-key="${e(item.key)}" aria-pressed="${pinned}" ${a("aria-label", pinned ? "skillWorkspace.unpin" : "skillWorkspace.pin", undefined, t)}>${codexIcon("pin")}</button></article>`;
}
const outputLabels: Record<SkillOutput, MessageId> = {
  document: "templates.outputDocument",
  image: "templates.outputImage",
  slides: "templates.outputSlides",
  video: "templates.outputVideo",
  web: "templates.outputWeb",
};
export function detailFrame(t: Translate, item: ManagedTemplate, pinned?: boolean) {
  const ref = item.reference,
    publishing = isPublishingTemplate(item);
  const sourceNames: Record<string, MessageId> = {
    builtin: "templates.builtinSource",
    installed: "templates.installedSource",
    upload: "templates.uploadSource",
    github: "templates.githubSource",
    authoring: "templates.authoredSource",
    captured: "sources.capturedOrigin",
  };
  const rows: [string, string][] = [
    [t(publishing ? "templates.resourceType" : "templates.type"), templateTypeName(t, item)],
    [t("templates.version"), ref.version],
    [t("templates.publisher"), item.publisher || t("templates.notDeclared")],
    [t("templates.license"), item.license || t("templates.notDeclared")],
    [t("templates.source"), t(sourceNames[item.origin.kind]!)],
    [t("templates.state"), templateState(t, item)],
    [
      t("templates.compatibility"),
      [
        ...item.compatibility.engines,
        ...item.compatibility.formats.map((format) => t(publicationFormatLabels[format])),
        ...item.compatibility.outputs.map((output) => t(outputLabels[output])),
      ].join(" · "),
    ],
  ];
  return `<header><div><span class="template-eyebrow">${e(templateTypeName(t, item))}</span><h2 id="managedTemplateTitle">${e(presentationLabel(t, item.label))}</h2></div><button type="button" class="wb-button" data-template-detail="close">${e(t("documents.close"))}</button></header><p>${e(presentationLabel(t, item.label, "description"))}</p><p class="template-detail-hint" data-template-hint></p>
    <nav class="styles-tabs" aria-label="${e(t("templates.details"))}"><button type="button" data-template-detail="overview" aria-pressed="true">${e(t("templates.overview"))}</button><button type="button" data-template-detail="preview" aria-pressed="false">${e(t("templates.preview"))}</button><button type="button" data-template-detail="versions" aria-pressed="false">${e(t("templates.versions"))}</button></nav><div data-template-overview><div class="template-detail-cover">${managedCover(item, true)}</div><dl class="template-metadata">${rows.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join("")}</dl><details><summary>${e(t("templates.identity"))}</summary><code>${e("id" in ref ? ref.id : ref.packageId + "." + ref.exportId)}@${e(ref.version)}</code><p><code>${e(ref.digest)}</code></p></details></div><div class="template-detail-preview" data-template-preview hidden></div><div data-template-versions hidden></div><p role="status" data-template-detail-notice></p><footer class="template-detail-actions">${pinned === undefined ? "" : `<button type="button" class="wb-button" data-template-detail="pin" aria-pressed="${pinned}">${codexIcon("pin")}${m(pinned ? "skillWorkspace.unpin" : "skillWorkspace.pin", undefined, t)}</button><button type="button" class="wb-button" data-template-detail="categorize">${codexIcon("folder")}${m("skillWorkspace.organizeSkill", undefined, t)}</button>`}<button type="button" class="wb-button primary" data-template-detail="apply" hidden>${e(t("creative.useSkill"))}</button><button type="button" class="wb-button" data-template-detail="edit" hidden>${e(t("templates.editCopy"))}</button><button type="button" class="wb-button" data-template-detail="export" hidden>${e(t("templates.export"))}</button><span class="template-actions-spacer"></span><button type="button" class="wb-button" data-template-detail="activate" hidden>${e(t("templates.setDefault"))}</button><button type="button" class="wb-button" data-template-detail="toggle" hidden>${e(t(item.state.exportEnabled ? "plugins.disable" : "plugins.enable"))}</button></footer>`;
}
