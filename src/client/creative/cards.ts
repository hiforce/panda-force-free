import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

export type CreativeCard = { kind: "document"; value: DocumentRecord } | { kind: "asset"; value: CreativeAsset };
export type CreativeFilter = "all" | "document" | "slides" | "web" | "trash";
export function creativeCards(t: Translate, rows: CreativeCard[], personal: boolean) {
  const date = (value: number) =>
    new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium" }).format(value);
  return rows
    .map(({ kind, value: d }) => {
      const asset = kind === "asset" ? (d as CreativeAsset) : null,
        open = asset ? "data-creative-asset" : "data-creative-open",
        copy = asset ? "data-creative-copy-asset" : "data-creative-copy",
        icon = asset ? (asset.kind === "slides" ? "monitor" : "globe") : "file",
        label = t(asset ? (asset.kind === "slides" ? "creative.slides" : "creative.web") : "creative.document");
      const preview = asset
        ? `<div class="creative-asset-cover" data-asset-kind="${asset.kind}"><span class="creative-asset-format">${asset.kind === "slides" ? "PPTX" : "HTML"}</span>${codexIcon(icon)}<span class="creative-asset-cover-lines" aria-hidden="true"></span></div>`
        : `<div class="creative-document-preview"><div class="creative-document-page"><small>${e(label)}</small><strong data-i18n-ignore>${e(d.title)}</strong><span class="creative-preview-lines" aria-hidden="true"></span></div></div>`;
      return `<article class="creative-card" data-creative-kind="${asset?.kind ?? "document"}"><button type="button" class="creative-card-open" ${open}="${e(d.id)}">${preview}<h2>${codexIcon(icon)}<span data-i18n-ignore>${e(d.title)}</span></h2></button><footer><small>${e(asset ? label : t("creative.saved"))} · ${e(date(d.updatedAt))}</small><button type="button" class="icon-button" ${asset?.state === "trashed" ? "data-creative-asset" : copy}="${e(d.id)}" ${asset || personal ? "" : "hidden"} aria-label="${e(t(asset?.state === "trashed" ? "creative.assetRestore" : "creative.copy"))}">${codexIcon(asset?.state === "trashed" ? "undo" : "copy")}</button></footer></article>`;
    })
    .join("");
}
