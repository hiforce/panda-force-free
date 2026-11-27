import { creativeFileExtension, creativeKindMessages, creativeKindIcons } from "../../shared/creative/file-types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { creativeAssetsApi } from "./assets-api.js";
import { messageAttributes } from "../i18n.js";

export type CreativeCard = { kind: "document"; value: DocumentRecord } | { kind: "asset"; value: CreativeAsset };
export type CreativeFilter = "all" | "document" | "slides" | "web" | "image" | "video" | "file" | "trash";
export function creativeCards(
  t: Translate,
  rows: CreativeCard[],
  personal: boolean,
  layout: "tiles" | "rows" = "tiles",
  selected = "",
) {
  const date = (value: number) =>
    new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium" }).format(value);
  const shortDate = new Intl.DateTimeFormat(document.documentElement.lang, { month: "short", day: "numeric" });
  return rows
    .map(({ kind, value: d }) => {
      const asset = kind === "asset" ? (d as CreativeAsset) : null,
        open = asset ? "data-creative-asset" : "data-creative-open",
        copy = asset ? "data-creative-copy-asset" : "data-creative-copy",
        icon = asset ? creativeKindIcons[asset.kind] : "file",
        label = t(asset ? creativeKindMessages[asset.kind] : "creative.document");
      const current = d.id === selected ? 'aria-current="true"' : "";
      if (layout === "rows") {
        return `<article class="creative-card project-gallery-row" data-creative-kind="${asset?.kind ?? "document"}">
          <button type="button" class="creative-card-open" ${open}="${e(d.id)}" ${current}>
            <span class="project-gallery-file-icon" aria-hidden="true">${codexIcon(icon)}</span>
            <span class="project-gallery-file-name"><strong data-i18n-ignore>${e(d.title)}</strong>${asset ? `<small data-i18n-ignore>${e(asset.source.name)}</small>` : ""}</span>
            <span class="project-gallery-file-kind">${e(label)}</span><time>${e(date(d.updatedAt))}</time>${codexIcon("chevronRight")}
          </button></article>`;
      }
      const image = asset?.kind === "image" && asset.state === "saved";
      const preview = asset
        ? `<div class="creative-asset-cover" data-asset-kind="${asset.kind}"><span class="creative-asset-format">${e(creativeFileExtension(asset.source.name).toUpperCase())}</span>${image ? `<img class="creative-thumbnail" data-creative-cover="${e(creativeAssetsApi.cover(asset))}" alt="" decoding="async" hidden><span class="sr-only" data-creative-cover-status></span>` : ""}${codexIcon(icon)}<span class="creative-asset-cover-lines" aria-hidden="true"></span></div>`
        : `<div class="creative-document-preview"><div class="creative-document-page"><small>${e(label)}</small><strong data-i18n-ignore>${e(d.title)}</strong><span class="creative-preview-lines" aria-hidden="true"></span></div></div>`;
      const timestamp = date(d.updatedAt);
      const detail = personal
        ? `<small>${e(asset?.state === "purging" ? t("creative.assetPurging") : asset ? label : t("creative.saved"))} · ${e(timestamp)}</small>`
        : `<time title="${e(timestamp)}" aria-label="${e(timestamp)}" datetime="${new Date(d.updatedAt).toISOString()}">${e(shortDate.format(d.updatedAt))}</time>`;
      return `<article class="creative-card" data-creative-kind="${asset?.kind ?? "document"}"><button type="button" class="creative-card-open" ${open}="${e(d.id)}" ${current}>${preview}<h2>${codexIcon(icon)}<span data-i18n-ignore>${e(d.title)}</span></h2></button>${image ? `<button type="button" class="icon-button creative-cover-retry" data-creative-cover-retry ${messageAttributes("aria-label", "creative.assetRetryCover", {}, t)} ${messageAttributes("title", "creative.assetRetryCover", {}, t)} hidden>${codexIcon("refreshCw")}</button>` : ""}<footer>${detail}<button type="button" class="icon-button" ${asset && asset.state !== "saved" ? "data-creative-asset" : copy}="${e(d.id)}" ${asset || personal ? "" : "hidden"} aria-label="${e(t(asset?.state === "purging" ? "creative.assetPurgeCheck" : asset?.state === "trashed" ? "creative.assetRestore" : "creative.copy"))}">${codexIcon(asset?.state === "purging" ? "refreshCw" : asset?.state === "trashed" ? "undo" : "copy")}</button></footer></article>`;
    })
    .join("");
}
