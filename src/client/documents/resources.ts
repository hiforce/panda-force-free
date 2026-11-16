import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord, DocumentAsset } from "../../shared/documents/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml, messageAttributes, errorText } from "../i18n.js";

import { documentApi, documentResourcesApi, DocumentApiError } from "./api.js";
import type { DocumentModal } from "./modal.js";
import { field } from "./views.js";

export interface DocumentResourceActions {
  images(document: DocumentRecord): Promise<string | null>;
  languages(document: DocumentRecord): Promise<void>;
}
/** Resource dialogs do not own editor state; insertion is explicitly returned to its caller. */
export class DocumentResources implements DocumentResourceActions {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
  ) {}
  async images(document: DocumentRecord) {
    const request = this.modal.generation;
    const result = await documentResourcesApi.assets(document.id);
    if (request !== this.modal.generation) return null;
    let assets = result.assets;
    const pending = this.modal.form(
      this.t("documents.assets"),
      `<p>${messageHtml("documents.assetHint", undefined, this.t)}</p><label for="documentAssetFile">${messageHtml("documents.uploadImage", undefined, this.t)}</label><input id="documentAssetFile" type="file" accept="image/png,image/jpeg,image/webp"><p id="documentAssetStatus" role="status"></p><div id="documentAssetList" class="document-assets"></div>${field(this.t, "documents.imageAlt", "alt", "", 'maxlength="500"')}`,
      this.t("documents.insertImage"),
      async (fields) => {
        const asset = assets.find((a) => a.id === fields.asset);
        if (!asset) throw new DocumentApiError(400, { messageId: "documents.invalidInput" });
        const alt = (fields.alt || asset.name).replace(/([\\[\]])/g, "\\$1").replace(/[\r\n]/g, " ");
        return `![${alt}](/api/document-assets/content?id=${asset.id})`;
      },
    );
    const generation = this.modal.generation,
      host = this.modal.element;
    const render = () => {
      setMessageHtml(
        host.querySelector("#documentAssetList"),
        assets.length
          ? assets
              .map(
                (a: DocumentAsset, i) =>
                  `<label class="document-asset"><input type="radio" name="document-asset" value="${e(a.id)}" ${i === assets.length - 1 ? "checked" : ""}><img src="/api/document-assets/content?id=${e(a.id)}" alt="" loading="lazy"><span data-i18n-ignore>${e(a.name)}<small>${a.width} × ${a.height}</small></span></label>`,
              )
              .join("")
          : messageHtml("documents.noAssets", undefined, this.t),
      );
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = !assets.length;
    };
    render();
    const file = host.querySelector<HTMLInputElement>("#documentAssetFile")!;
    file.onchange = async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      const status = host.querySelector<HTMLElement>("#documentAssetStatus")!;
      file.disabled = true;
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = true;
      status.textContent = this.t("documents.saving");
      try {
        const { asset } = await documentResourcesApi.upload(document.id, selected);
        if (generation !== this.modal.generation) return;
        assets = [...assets, asset];
        render();
        status.textContent = "";
      } catch (error) {
        if (generation === this.modal.generation)
          status.textContent = errorText(
            error instanceof DocumentApiError ? error.payload : null,
            this.t,
            "documents.unavailable",
          );
      } finally {
        file.disabled = false;
        if (generation === this.modal.generation)
          host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = !assets.length;
      }
    };
    return pending;
  }
  async languages(document: DocumentRecord) {
    const request = this.modal.generation;
    let { documents: linked } = await documentResourcesApi.languages(document.id);
    if (request !== this.modal.generation) return;
    const pending = this.modal.form(
      this.t("documents.languages"),
      `<p>${messageHtml("documents.languageHint", undefined, this.t)}</p><h3>${messageHtml("documents.linked", undefined, this.t)}</h3><ul id="documentLinkedLanguages"></ul><button type="button" id="documentUnlink" class="wb-button">${messageHtml("documents.unlinkLanguage", undefined, this.t)}</button><label for="documentLanguageSearch">${messageHtml("documents.languageSearch", undefined, this.t)}</label><input type="search" id="documentLanguageSearch" ${messageAttributes("placeholder", "documents.search", undefined, this.t)}><div id="documentLanguageCandidates"></div><p id="documentLanguageStatus" role="status"></p>`,
      this.t("documents.linkLanguage"),
      async (fields) => {
        await documentResourcesApi.link(document.id, fields.other!);
        return true;
      },
    );
    const generation = this.modal.generation,
      host = this.modal.element;
    const status = host.querySelector<HTMLElement>("#documentLanguageStatus")!;
    const search = host.querySelector<HTMLInputElement>("#documentLanguageSearch")!;
    let queryEpoch = 0;
    const renderLinked = () => {
      setMessageHtml(
        host.querySelector("#documentLinkedLanguages"),
        linked.map((d) => `<li data-i18n-ignore>${e(d.locale)} · ${e(d.title)}</li>`).join(""),
      );
      host.querySelector<HTMLButtonElement>("#documentUnlink")!.disabled = linked.length < 2;
    };
    const refresh = async () => {
      const current = ++queryEpoch;
      try {
        const page = await documentApi.list(document.spaceId, search.value);
        if (current !== queryEpoch || generation !== this.modal.generation) return;
        const ids = new Set(linked.map((d) => d.id)),
          locales = new Set(linked.map((d) => d.locale.toLowerCase()));
        const candidates = page.documents.filter((d) => !ids.has(d.id) && !locales.has(d.locale.toLowerCase()));
        setMessageHtml(
          host.querySelector("#documentLanguageCandidates"),
          candidates.length
            ? candidates
                .map(
                  (d) =>
                    `<label class="document-language-option"><input type="radio" name="document-other" value="${e(d.id)}" required><span data-i18n-ignore>${e(d.locale)} · ${e(d.title)}<small>${e(d.path)}</small></span></label>`,
                )
                .join("")
            : messageHtml("documents.noLanguageCandidates", undefined, this.t),
        );
        host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = !candidates.length;
      } catch (error) {
        if (generation === this.modal.generation)
          status.textContent = errorText(
            error instanceof DocumentApiError ? error.payload : null,
            this.t,
            "documents.unavailable",
          );
      }
    };
    search.oninput = () => void refresh();
    host.querySelector<HTMLButtonElement>("#documentUnlink")!.onclick = async () => {
      try {
        const result = await documentResourcesApi.unlink(document.id);
        if (generation !== this.modal.generation) return;
        linked = result.documents;
        renderLinked();
        void refresh();
      } catch (error) {
        if (generation === this.modal.generation)
          status.textContent = errorText(
            error instanceof DocumentApiError ? error.payload : null,
            this.t,
            "documents.unavailable",
          );
      }
    };
    renderLinked();
    void refresh();
    await pending;
  }
}
