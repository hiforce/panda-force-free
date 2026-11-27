import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { CreativeAssetKind } from "../../shared/creative/assets.js";
import { creativeKindIcons, creativeKindMessages } from "../../shared/creative/file-types.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes, messageHtml } from "../i18n.js";
import type { CreativeFilter } from "./cards.js";
import { projectCreationPath } from "./project-view.js";
import { readerIcon } from "./reader-toolbar.js";

export function projectAssetKind(filter: CreativeFilter): CreativeAssetKind | undefined {
  return filter === "all" || filter === "document" || filter === "trash" ? undefined : filter;
}

export function projectGalleryLabel(filter: CreativeFilter): MessageId {
  const kind = projectAssetKind(filter);
  return kind ? creativeKindMessages[kind] : filter === "trash" ? "creative.assetFileTrash" : "creative.assetLibrary";
}

export function projectGallery(t: Translate, project: string) {
  const iconLabel = messageAttributes("aria-label", "creative.assetFileTrash", {}, t);
  return `<div class="project-gallery" data-project-gallery>
    <section class="project-gallery-catalog">
      <div class="project-gallery-tools">
        <h2 data-creative-library>${messageHtml("creative.assetLibrary", {}, t)}</h2>
        <label class="resource-search">${codexIcon("search")}<input type="search" data-creative-search
          ${messageAttributes("placeholder", "creative.assetSearchLoaded", {}, t)}
          ${messageAttributes("aria-label", "creative.assetSearchLoaded", {}, t)}></label>
        <a class="icon-button project-gallery-trash" data-project-trash href="${projectCreationPath(project, "trash")}"
           ${iconLabel} ${messageAttributes("title", "creative.assetFileTrash", {}, t)}>${codexIcon("trash")}</a>
      </div>
      <p role="status" data-creative-status></p>
      <div class="creative-grid project-gallery-grid" data-creative-grid></div>
      <button type="button" class="wb-button" data-creative-more hidden>${messageHtml("templates.loadMore", {}, t)}</button>
    </section>
    <section class="project-asset-reader" data-project-asset-reader aria-labelledby="projectAssetTitle" hidden>
      <header class="project-asset-bar">
        ${readerIcon(t, "creative.closeContent", "arrowLeft", "data-project-asset-close")}
        <h2 id="projectAssetTitle" data-project-asset-title data-i18n-ignore></h2>
        <div class="project-asset-commands" data-project-asset-commands></div>
      </header>
      <div class="project-asset-content" data-project-asset-content></div>
    </section>
  </div>`;
}

export function projectGalleryEmpty(t: Translate, filter: CreativeFilter, canContribute: boolean) {
  const kind = projectAssetKind(filter);
  const title =
    kind === "image"
      ? "projects.emptyImages"
      : kind === "slides"
        ? "projects.emptySlides"
        : kind === "web"
          ? "projects.emptyWeb"
          : filter === "all"
            ? "projects.emptyContentTitle"
            : filter === "trash"
              ? "creative.assetTrashEmpty"
              : "creative.empty";
  return `<div class="project-gallery-empty">
    <span class="project-gallery-empty-symbol" aria-hidden="true">${codexIcon(kind ? creativeKindIcons[kind] : filter === "trash" ? "trash" : "file")}</span>
    <h3>${messageHtml(title, {}, t)}</h3>
    ${canContribute && kind ? `<button class="wb-button" type="button" data-project-import>${codexIcon("fileInput")}${messageHtml("creative.assetImport", {}, t)}</button>` : ""}
    ${canContribute && filter === "all" ? `<button class="wb-button" type="button" data-project-compose>${codexIcon("plus")}${messageHtml("creation.trigger", {}, t)}</button>` : ""}
  </div>`;
}
