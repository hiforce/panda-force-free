import { escapeHtml as e } from "../../../shared/html.js";
import type { Translate } from "../../../shared/i18n/messages.js";
import { codexIcon } from "../../codex-icons.js";
import { messageAttributes } from "../../i18n.js";

export function personalWorkCard(
  t: Translate,
  row: {
    kind: string;
    title: string;
    metadata: string;
    icon: string;
    action: string;
    disabled?: boolean;
    cover?: string;
  },
) {
  const cover = row.cover
    ? `<img data-creative-cover="${e(row.cover)}" decoding="async" alt="" hidden><span class="sr-only" data-creative-cover-status></span>`
    : "";
  const glyph =
    row.kind === "document"
      ? `<span class="personal-document-sheet" aria-hidden="true">${codexIcon("file")}</span>`
      : codexIcon(row.icon, "personal-work-glyph");
  return `<article class="personal-work-card" data-creative-cover-card data-work-kind="${e(row.kind)}">
    <button type="button" class="personal-work-open" ${row.action} ${row.disabled ? "disabled" : ""} title="${e(row.title)}">
      <span class="personal-work-cover">${glyph}${cover}${row.kind === "video" ? codexIcon("play", "personal-work-play") : ""}</span>
      <span class="personal-work-caption"><strong data-i18n-ignore>${e(row.title)}</strong><small>${e(row.metadata)}</small></span>
    </button>
    ${cover ? `<button type="button" class="icon-button personal-work-retry" data-creative-cover-retry ${messageAttributes("aria-label", "creative.assetRetryCover", {}, t)} ${messageAttributes("title", "creative.assetRetryCover", {}, t)} hidden>${codexIcon("refreshCw")}</button>` : ""}
  </article>`;
}
