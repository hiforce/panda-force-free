import type { Translate } from "../../shared/i18n/messages.js";
import { PORTABLE_TEMPLATE_JSON_BYTES } from "../../shared/templates/portable/bundle.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { PluginApiError } from "../plugins/api.js";
import { inspectCompatibilityTemplate } from "./compatibility-import.js";
import { inspectPortableTemplates } from "./portable-import.js";
import { createTemplateImportReview } from "./import-review.js";
import { templateImportFormat } from "./import-file.js";

/** Upload acquisition and the shared review component have independent lifetimes. */
export function createNativeTemplateImport(
  t: Translate,
  changed: () => void,
  openSource: (file: File) => Promise<void>,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "package-dialog template-import-dialog";
  dialog.id = "managedTemplateImport";
  document.body.append(dialog);
  let previous: HTMLElement | null = null,
    review: ReturnType<typeof createTemplateImportReview> | null = null,
    acquisition = 0;
  function close() {
    acquisition++;
    review?.reset();
    review = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  }
  dialog.onchange = (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.matches("[data-import-file]")) return;
    const file = event.target.files?.[0];
    const generation = ++acquisition;
    if (!file) {
      review?.reset();
      return;
    }
    void templateImportFormat(file)
      .then(async (format) => {
        if (generation !== acquisition || !dialog.open) return;
        if (format === "archive") {
          close();
          await openSource(file);
          return;
        }
        await review?.load(async () => {
          if (file.size > PORTABLE_TEMPLATE_JSON_BYTES)
            throw new PluginApiError(413, { messageId: "plugins.packageTooLarge" });
          const text = await file.text();
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
          }
          return value && typeof value === "object" && "kind" in value && value.kind === "panda-force.template-bundle"
            ? inspectPortableTemplates(t, text, file.name)
            : inspectCompatibilityTemplate(t, text, file.name, value);
        });
      })
      .catch((error) => {
        if (generation === acquisition && dialog.open)
          void review?.load(async () => {
            throw error;
          });
      });
  };
  dialog.onclick = (event) => {
    if (event.target instanceof Element && event.target.closest('[data-import-action="close"]')) close();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  return {
    close,
    open() {
      close();
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMessageHtml(
        dialog,
        `<header><h2>${e(t("templates.import"))}</h2><button type="button" class="wb-button" data-import-action="close">${e(t("documents.close"))}</button></header><p>${e(t("templates.nativeImportHint"))}</p><input type="file" accept="application/json,.json,application/zip,.zip,.pptx,.potx,.pptm,.potm" data-import-file aria-label="${e(t("templates.import"))}"><section data-template-review-host></section>`,
      );
      review = createTemplateImportReview(
        t,
        dialog.querySelector<HTMLElement>("[data-template-review-host]")!,
        changed,
        (busy) => {
          const input = dialog.querySelector<HTMLInputElement>("[data-import-file]");
          if (input) input.disabled = busy;
        },
      );
      dialog.showModal();
    },
  };
}
