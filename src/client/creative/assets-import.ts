import { creativeImportKind, creativeKindMatchesName } from "../../shared/creative/file-types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import {
  CREATIVE_ASSET_LIMITS as limits,
  type CreativeAsset,
  type CreativeAssetKind,
} from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { DocumentModal } from "../documents/modal.js";
import { DocumentApiError } from "../documents/api.js";
import { creativeAssetsApi } from "./assets-api.js";
import { CreativeBundleSelection } from "./assets-bundle.js";
import { setMessageHtml } from "../i18n.js";

export async function importCreativeAsset(
  modal: DocumentModal,
  t: Translate,
  project: string,
  signal: AbortSignal,
  previous?: CreativeAsset,
  category?: CreativeAssetKind,
) {
  let priorFile: File | undefined,
    signature = "",
    operationId = crypto.randomUUID(),
    id = previous?.id ?? "c-" + crypto.randomUUID();
  let submitting = false;
  let bundle: CreativeBundleSelection;
  const target = previous?.kind ?? category;
  const acceptsArchive = !target || target === "web";
  const archiveFile = (file: File) => file.name.toLowerCase().endsWith(".zip") && acceptsArchive;
  const selectedFile = () => modal.element.querySelector<HTMLInputElement>('[name="document-source"]')?.files?.[0],
    canSubmit = () => {
      const file = selectedFile();
      return !submitting && !!file && (!archiveFile(file) || !!bundle?.entry(file));
    },
    accept =
      target === "slides"
        ? ".pptx"
        : target === "web"
          ? ".html,.zip"
          : target === "image"
            ? ".png,.jpg,.jpeg,.webp,.gif,.avif"
            : target === "video"
              ? ".mp4,.webm,.mov,.m4v"
              : "";
  const result = modal.form(
    t(previous ? "creative.assetReplace" : "creative.assetImport"),
    `<p>${e(t("creative.assetImportHint"))}</p><label class="wb-field"><span>${e(t("creative.assetFile"))}</span><input class="wb-input" type="file" name="document-source" accept="${accept}" required></label><label class="wb-field"><span>${e(t("creative.assetTitle"))}</span><input class="wb-input" name="document-title" required maxlength="200" value="${e(previous?.title ?? "")}"></label><label class="wb-field"><span>${e(t("creative.assetLanguage"))}</span><input class="wb-input" name="document-locale" required value="${e(previous?.locale ?? (document.documentElement.lang || "en"))}" maxlength="35"></label><p role="status" data-asset-import-status></p>`,
    t(previous ? "creative.assetSaveVersion" : "creative.assetImport"),
    async (fields) => {
      const file = selectedFile();
      if (!file) throw new DocumentApiError(400, { messageId: "creative.assetInvalidFile" });
      const archive = archiveFile(file),
        entry = archive ? bundle.entry(file) : undefined,
        kind = previous?.kind ?? creativeImportKind(file.name);
      if (
        (target !== undefined && target !== kind) ||
        (!archive && !creativeKindMatchesName(kind, file.name)) ||
        !file.size ||
        file.size > (kind === "web" && !archive ? limits.htmlBytes : limits.sourceBytes) ||
        (archive && !entry)
      )
        throw new DocumentApiError(400, { messageId: "creative.assetInvalidFile" });
      const next = JSON.stringify([fields.title, fields.locale, entry]);
      if (priorFile !== file || next !== signature) {
        operationId = crypto.randomUUID();
        id = previous?.id ?? "c-" + crypto.randomUUID();
        priorFile = file;
        signature = next;
      }
      modal.element.querySelector("[data-asset-import-status]")!.textContent = t("creative.assetImporting");
      submitting = true;
      const form = modal.element.querySelector<HTMLFormElement>("form")!;
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"))
        control.disabled = true;
      try {
        return await creativeAssetsApi.import(
          project,
          file,
          fields.title!,
          fields.locale!,
          id,
          operationId,
          previous,
          signal,
          entry,
        );
      } finally {
        submitting = false;
        for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"))
          control.disabled = false;
        const status = form.querySelector("[data-asset-import-status]");
        if (status) status.textContent = "";
      }
    },
    {
      canSubmit,
    },
  );
  const section = document.createElement("div");
  section.hidden = true;
  section.dataset.assetBundleFields = "";
  setMessageHtml(
    section,
    `<label class="wb-field"><span>${e(t("creative.assetBundleEntry"))}</span><select name="document-entry"></select></label><p role="status" data-asset-bundle-status></p><button type="button" class="wb-button" data-asset-bundle-retry hidden>${e(t("creative.retry"))}</button>`,
  );
  modal.element.querySelector('[name="document-source"]')!.closest("label")!.after(section);
  bundle = new CreativeBundleSelection(
    modal,
    t,
    project,
    signal,
    () => {
      if (bundle?.active) modal.element.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = !canSubmit();
    },
    acceptsArchive,
  );
  modal.element.querySelector<HTMLInputElement>('[name="document-source"]')!.onchange = () => {
    if (submitting) return;
    const file = modal.element.querySelector<HTMLInputElement>('[name="document-source"]')!.files?.[0],
      title = modal.element.querySelector<HTMLInputElement>('[name="document-title"]')!;
    if (!title.value && file) title.value = file.name.replace(/\.[^.]+$/, "");
    void bundle.load(file);
  };
  return result.finally(() => bundle.close());
}
