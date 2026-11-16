import type { Translate, MessageId } from "../../../shared/i18n/messages.js";
import type { DocumentRecord, DocumentSpace } from "../../../shared/documents/contracts.js";
import type { DocumentPlacement } from "../../../shared/documents/placements.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { messageHtml as m } from "../../i18n.js";
import { codexIcon } from "../../codex-icons.js";

export const publicationButton = (
  t: Translate,
  key: MessageId,
  action: string,
  extra = "",
  { primary = false, danger = false }: { primary?: boolean; danger?: boolean } = {},
) =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}${danger ? " danger" : ""}" data-placement-action="${action}" ${extra}>${m(key, undefined, t)}</button>`;
export function publicationFrame(t: Translate, document: DocumentRecord) {
  return `<header class="document-publication-heading"><div><p>${m("documents.publicationEyebrow", undefined, t)}</p><h2 id="documentPublicationTitle" data-i18n-ignore>${e(document.title)}</h2></div>${publicationButton(t, "documents.close", "close")}</header><div class="document-publication-body"><p class="document-publication-intro">${m("documents.publicationHint", undefined, t)}</p><div id="placementNotice" class="documents-notice" role="status" aria-live="polite" hidden></div><aside id="placementRecoveryNotice" class="documents-notice" role="status" hidden><p>${m("documents.pendingPublicationChange", undefined, t)}</p>${publicationButton(t, "documents.retryPublicationChange", "retry")}</aside><section class="document-publication-channels"><div><h3>${m("editorial.channels", undefined, t)}</h3><p>${m("editorial.channelsHint", undefined, t)}</p></div><div>${publicationButton(t, "editorial.open", "spacing")}${publicationButton(t, "publishing.open", "channels", "", { primary: true })}</div></section><div class="document-publication-toolbar"><h3>${m("documents.publicationSites", undefined, t)}</h3><div>${publicationButton(t, "documents.refreshLinks", "refresh")}${publicationButton(t, "documents.createPublicationSpace", "new-space")}${publicationButton(t, "documents.addPublicationLink", "add", "", { primary: true })}</div></div><section id="documentPlacementList" aria-label="${e(t("documents.publicationSites"))}"></section><footer class="document-publication-footer"><span>${codexIcon("file")}<span>${m("documents.originalUnchanged", undefined, t)}</span></span></footer></div>`;
}
export function publicationLinks(
  t: Translate,
  placements: DocumentPlacement[],
  spaces: DocumentSpace[],
  destinations = false,
) {
  if (!placements.length)
    return `<div class="document-publication-empty">${codexIcon("globe")}<h3>${m("documents.noPublicationLinks", undefined, t)}</h3><p>${m("documents.noPublicationLinksHint", undefined, t)}</p></div>`;
  return placements
    .map((placement) => {
      const space = spaces.find((value) => value.id === placement.spaceId);
      return `<article class="document-publication-card" data-placement-id="${e(placement.id)}"><header><div class="document-publication-site-icon">${codexIcon("globe")}</div><div><h3 data-i18n-ignore>${e(space?.name || t("documents.notFound"))}</h3><p><span>${e(space?.engine || "")}</span><span lang="en" data-i18n-ignore>${e(placement.locale)}</span><span>${m(placement.revisionId ? "documents.linkPinned" : "documents.linkLatest", undefined, t)}</span></p></div></header><div class="document-publication-path" data-i18n-ignore>${codexIcon("file")}<code>${e(placement.path)}</code></div>${typeof placement.metadata.title === "string" ? `<p class="document-publication-title" data-i18n-ignore>${e(placement.metadata.title)}</p>` : ""}<footer>${publicationButton(t, "documents.editPublicationLink", "edit", `data-id="${e(placement.id)}"`)}${publicationButton(t, "documents.chooseTheme", "theme", `data-id="${e(placement.id)}"`)}${space?.engine === "hexo" && space.sourceMode === "external" ? publicationButton(t, "documents.sourceSettings", "source-profile", `data-id="${e(placement.id)}"`) : ""}${publicationButton(t, "documents.linkHistory", "history", `data-id="${e(placement.id)}"`)}${publicationButton(t, "documents.removePublicationLink", "remove", `data-id="${e(placement.id)}"`, { danger: true })}${destinations ? publicationButton(t, "delivery.open", "delivery", `data-id="${e(placement.id)}"`) : ""}${publicationButton(t, "documents.buildPublicationSite", "build", `data-id="${e(placement.id)}"`, { primary: true })}</footer></article>`;
    })
    .join("");
}
