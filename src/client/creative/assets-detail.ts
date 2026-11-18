import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAssetDetail } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { creativeAssetsApi } from "./assets-api.js";
import { creativeFilePreview, creativeKindMessages } from "../../shared/creative/file-types.js";

function nativePreview(t: Translate, value: CreativeAssetDetail) {
  const asset = value.asset,
    preview = creativeFilePreview(asset.source.name),
    url = e(creativeAssetsApi.view(asset.project, asset.id, asset.version));
  if (preview.kind === "download" || value.previewUnavailable) return `<p>${e(t("creative.assetDownloadOnly"))}</p>`;
  if (preview.kind === "pdf" && globalThis.navigator?.pdfViewerEnabled === false)
    return `<p>${e(t("creative.assetDownloadOnly"))}</p>`;
  const source =
    preview.kind === "image"
      ? `<img class="creative-native-image" data-asset-native src="${url}" alt="${e(asset.title)}" decoding="async">`
      : preview.kind === "video" || preview.kind === "audio"
        ? `<${preview.kind} class="creative-native-media" data-asset-native src="${url}" controls preload="metadata" ${preview.kind === "video" ? "playsinline" : ""}></${preview.kind}>`
        : preview.kind === "pdf"
          ? `<iframe class="creative-asset-frame" data-asset-native src="${url}" title="${e(asset.title)}" sandbox referrerpolicy="no-referrer"></iframe>`
          : `${value.previewTruncated ? `<p>${e(t("creative.assetPreviewTruncated"))}</p>` : ""}<pre class="creative-asset-text" data-i18n-ignore>${e(value.text)}</pre>`;
  return `<p>${e(t("creative.assetNativeHint"))}</p>${source}<p data-asset-view-error role="status" hidden>${e(t("creative.assetPreviewFailed"))} <button type="button" class="wb-button" data-asset-view-retry>${e(t("common.retry"))}</button></p>`;
}

export function creativeAssetDetail(t: Translate, value: CreativeAssetDetail, editable: boolean) {
  const asset = value.asset,
    slides = asset.kind === "slides",
    authored = slides || asset.kind === "web";
  const facts = `<dl class="creative-asset-facts"><div><dt>${e(t("creative.assetVersion"))}</dt><dd><code title="${e(asset.version)}" data-i18n-ignore>${e(asset.version.slice(0, 12))}</code></dd></div><div><dt>${e(t("creative.saved"))}</dt><dd>${e(new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" }).format(asset.updatedAt))}</dd></div></dl>`;
  return `<div class="creative-asset-meta"><span class="resource-badge">${e(t(creativeKindMessages[asset.kind]))}</span><span data-i18n-ignore>${e(asset.locale)} · ${e(asset.source.name)}</span></div>${facts}<div class="creative-asset-actions"><a class="wb-button" href="${e(creativeAssetsApi.content(asset.project, asset.id, asset.version))}" download>${codexIcon("file")}${e(t("creative.assetDownload"))}</a>${!authored && !value.previewUnavailable && creativeFilePreview(asset.source.name).kind !== "download" ? `<a class="wb-button" href="${e(creativeAssetsApi.view(asset.project, asset.id, asset.version))}" target="_blank" rel="noopener noreferrer">${e(t("creative.assetOpenOriginal"))}</a>` : ""}<button class="wb-button" type="button" data-asset-copy>${codexIcon("copy")}${e(t("creative.copy"))}</button>${asset.kind === "web" && asset.resources.length ? `<a class="wb-button" href="${e(creativeAssetsApi.bundle(asset.project, asset.id, asset.version))}" download>${e(t("creative.assetDownloadBundle"))}</a>` : ""}${editable ? `${authored ? `<button class="wb-button" type="button" data-asset-knowledge>${e(t("knowledge.open"))}</button>` : ""}<button class="wb-button" type="button" data-asset-replace>${e(t("creative.assetReplace"))}</button><button class="wb-button" type="button" data-asset-trash>${codexIcon("trash")}${e(t("creative.assetTrash"))}</button>` : ""}</div>${asset.copiedFrom ? `<p>${e(t("creative.assetCopiedVersion"))} <code data-i18n-ignore>${e(asset.copiedFrom.version.slice(0, 12))}</code></p>` : ""}${!authored ? nativePreview(t, value) : !slides && value.previewHtml ? `<p>${e(t("creative.assetStaticHint"))}</p><div data-asset-preview></div><details class="creative-asset-extracted"><summary>${e(t("creative.assetReadableText"))}</summary><div class="creative-asset-text" data-i18n-ignore>${e(value.text)}</div></details>` : `<p>${e(t(slides ? "creative.assetSlideHint" : "creative.assetPreviewUnavailable"))}</p><div class="creative-asset-sections">${value.sections.map((s, i) => `<section><h3>${e(slides ? t("creative.assetSlide", { index: i + 1 }) : t("creative.assetReadableText"))}</h3><div class="creative-asset-text" data-i18n-ignore>${e(value.text.slice(s.start, s.end) || t("creative.assetNoText"))}</div></section>`).join("")}</div>`}`;
}
