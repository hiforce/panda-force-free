import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAssetDetail } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { creativeAssetsApi } from "./assets-api.js";
import { slidePreviewView } from "./slides-preview.js";
import { readerIcon, readerMore } from "./reader-toolbar.js";
import { messageAttributes, messageHtml } from "../i18n.js";
import { creativeFilePreview, creativeKindMessages } from "../../shared/creative/file-types.js";

function nativePreview(t: Translate, value: CreativeAssetDetail, compact: boolean) {
  const asset = value.asset,
    preview = creativeFilePreview(asset.source.name),
    url = e(creativeAssetsApi.view(asset.project, asset.id, asset.version));
  if (preview.kind === "download" || value.previewUnavailable)
    return `<p>${messageHtml("creative.assetDownloadOnly", {}, t)}</p>`;
  if (preview.kind === "pdf" && globalThis.navigator?.pdfViewerEnabled === false)
    return `<p>${messageHtml("creative.assetDownloadOnly", {}, t)}</p>`;
  const source =
    preview.kind === "image"
      ? `<img class="creative-native-image" data-asset-native src="${url}" alt="${e(asset.title)}" decoding="async">`
      : preview.kind === "video" || preview.kind === "audio"
        ? `<${preview.kind} class="creative-native-media" data-asset-native src="${url}" controls preload="metadata" ${preview.kind === "video" ? "playsinline" : ""}></${preview.kind}>`
        : preview.kind === "pdf"
          ? `<iframe class="creative-asset-frame" data-asset-native src="${url}" title="${e(asset.title)}" sandbox referrerpolicy="no-referrer"></iframe>`
          : `${value.previewTruncated ? `<p>${messageHtml("creative.assetPreviewTruncated", {}, t)}</p>` : ""}<pre class="creative-asset-text" data-i18n-ignore>${e(value.text)}</pre>`;
  return `${compact ? "" : `<p>${messageHtml("creative.assetNativeHint", {}, t)}</p>`}${source}<p data-asset-view-error role="status" hidden>${messageHtml("creative.assetPreviewFailed", {}, t)} <button type="button" class="wb-button" data-asset-view-retry>${messageHtml("common.retry", {}, t)}</button></p>`;
}

export function creativeAssetDetail(t: Translate, value: CreativeAssetDetail, editable: boolean, compact = false) {
  const asset = value.asset,
    slides = asset.kind === "slides",
    authored = slides || asset.kind === "web";
  const meta = `<div class="creative-asset-meta"><span class="resource-badge">${messageHtml(creativeKindMessages[asset.kind], {}, t)}</span><span data-i18n-ignore>${e(asset.locale)} · ${e(asset.source.name)}</span></div>`;
  const facts = `<dl class="creative-asset-facts"><div><dt>${messageHtml("creative.assetVersion", {}, t)}</dt><dd><code title="${e(asset.version)}" data-i18n-ignore>${e(asset.version.slice(0, 12))}</code></dd></div><div><dt>${messageHtml("creative.saved", {}, t)}</dt><dd>${e(new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" }).format(asset.updatedAt))}</dd></div></dl>`;
  const original = `href="${e(creativeAssetsApi.content(asset.project, asset.id, asset.version))}" download`;
  const download = `<a class="wb-button" ${original} ${messageAttributes("aria-label", "creative.assetDownload", {}, t)} ${messageAttributes("title", "creative.assetDownload", {}, t)}>${codexIcon("download")}${messageHtml("creative.assetDownload", {}, t)}</a>`;
  const link =
    asset.originalStore === "object"
      ? `<button type="button" class="wb-button" data-asset-get-link>${messageHtml(asset.kind === "image" ? "creative.assetGetImageLink" : "creative.assetGetFileLink", {}, t)}</button>`
      : "";
  const secondary = `${!authored && !value.previewUnavailable && creativeFilePreview(asset.source.name).kind !== "download" ? `<a class="wb-button" href="${e(creativeAssetsApi.view(asset.project, asset.id, asset.version))}" target="_blank" rel="noopener noreferrer">${messageHtml("creative.assetOpenOriginal", {}, t)}</a>` : ""}<button class="wb-button" type="button" data-asset-copy>${codexIcon("copy")}${messageHtml("creative.copy", {}, t)}</button>${asset.kind === "web" && asset.resources.length ? `<a class="wb-button" href="${e(creativeAssetsApi.bundle(asset.project, asset.id, asset.version))}" download>${messageHtml("creative.assetDownloadBundle", {}, t)}</a>` : ""}${editable ? `${authored ? `<button class="wb-button" type="button" data-asset-knowledge>${messageHtml("knowledge.open", {}, t)}</button>` : ""}<button class="wb-button" type="button" data-asset-replace>${messageHtml("creative.assetReplace", {}, t)}</button><button class="wb-button" type="button" data-asset-trash>${codexIcon("trash")}${messageHtml("creative.assetTrash", {}, t)}</button>` : ""}`;
  const provenance = asset.copiedFrom
    ? `<p>${messageHtml("creative.assetCopiedVersion", {}, t)} <code data-i18n-ignore>${e(asset.copiedFrom.version.slice(0, 12))}</code></p>`
    : "";
  const sections = () =>
    `<div class="creative-asset-sections">${value.sections.map((s, i) => `<section><h3>${slides ? messageHtml("creative.assetSlide", { index: i + 1 }, t) : messageHtml("creative.assetReadableText", {}, t)}</h3><div class="creative-asset-text" data-i18n-ignore>${e(value.text.slice(s.start, s.end) || t("creative.assetNoText"))}</div></section>`).join("")}</div>`;
  const preview = slides
    ? slidePreviewView(t, sections())
    : !authored
      ? nativePreview(t, value, compact)
      : value.previewHtml
        ? `${compact ? "" : `<p>${messageHtml("creative.assetStaticHint", {}, t)}</p>`}<div data-asset-preview></div><details class="creative-asset-extracted"><summary>${messageHtml("creative.assetReadableText", {}, t)}</summary><div class="creative-asset-text" data-i18n-ignore>${e(value.text)}</div></details>`
        : `<p>${messageHtml("creative.assetPreviewUnavailable", {}, t)}</p>${sections()}`;
  const linkPanel = asset.originalStore === "object" ? `<section data-asset-link hidden></section>` : "";
  if (compact) {
    const toolbar =
      readerIcon(t, "creative.assetDownload", "download", original, "a") +
      readerMore(
        t,
        `<div class="creative-asset-actions">${link}${secondary}</div>${meta}${facts}${provenance}`,
        "personal-asset-more",
      );
    return { toolbar, body: linkPanel + preview };
  }
  return {
    toolbar: "",
    body: `${meta}${facts}<div class="creative-asset-actions">${link}${download}${secondary}</div>${provenance}${linkPanel}${preview}`,
  };
}
