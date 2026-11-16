import type { Translate } from "../../../shared/i18n/messages.js";
import type { ManagedTemplate } from "../../../shared/templates/catalog.js";
import type { PortableTemplateManifest } from "../../../shared/templates/portable/contracts.js";
import type { DocumentLayoutTemplate, RichDocumentLayoutTemplate } from "../../../shared/templates/types/contracts.js";
import type { TreeIntent } from "./tree-api.js";
import type { DocumentTreeMutation } from "../../../shared/documents/navigation.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml, localizeText, errorText } from "../../i18n.js";

import { PluginApiError } from "../../plugins/api.js";
import { managedTemplatesApi } from "../../templates/api.js";
import { portableTemplatesApi } from "../../templates/portable-api.js";
import { portableTemplatePreview } from "../../templates/portable-preview.js";
import { templatePreviewImages } from "../../templates/preview-images.js";
import { presentationText } from "../../../shared/presentation/labels.js";
import { DocumentModal } from "../modal.js";
import { applicationFields, readApplicationFields } from "./template-fields.js";

type Selection = {
  reference: { id: string; version: string; digest: string };
  manifest: PortableTemplateManifest;
  model: DocumentLayoutTemplate | RichDocumentLayoutTemplate;
};
/** Discovery and form lifetime stay local; the existing tree session owns creation identity, durable retry and navigation. */
export class DocumentTemplatePicker {
  private readonly modal: DocumentModal;
  constructor(private t: Translate) {
    this.modal = new DocumentModal(t, "documentTemplatePicker");
  }
  close() {
    this.modal.close();
  }
  async open(
    parentId: string | null,
    create: (intent: Extract<TreeIntent, { kind: "create-template" }>) => Promise<DocumentTreeMutation | null>,
  ) {
    const { t, modal } = this;
    let selection: Selection | null = null,
      cursor: string | null = null,
      reads = 0,
      previews = 0,
      creating = false;
    const pending = modal.form(
      t("templates.createDocumentFromTemplate"),
      `<p>${e(t("templates.documentApplicationHint"))}</p><div class="document-template-picker"><section><label for="documentTemplateSearch">${e(t("templates.search"))}</label><input id="documentTemplateSearch" type="search" maxlength="200" autocomplete="off"><p data-picker-notice role="status"></p><div data-picker-choices></div><button type="button" class="wb-button" data-picker-more hidden>${e(t("templates.loadMore"))}</button></section><section><div data-picker-fields></div><details data-picker-preview hidden><summary>${e(t("templates.structurePreview"))}</summary><div></div></details></section></div>`,
      t("templates.createEditableDocument"),
      async (fields) => {
        if (!selection || creating) return null;
        const intent: Extract<TreeIntent, { kind: "create-template" }> = {
          kind: "create-template",
          title: fields.title!,
          locale: document.documentElement.lang || "en",
          parentId,
          template: selection.reference,
          values: readApplicationFields(fields, selection.manifest, selection.model),
        };
        creating = true;
        dialog.setAttribute("aria-busy", "true");
        const inputs = [
          ...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
            "input,select,textarea,.document-template-choice,[data-picker-more]",
          ),
        ];
        for (const node of inputs) node.disabled = true;
        try {
          return await create(intent);
        } finally {
          creating = false;
          if (current()) {
            dialog.setAttribute("aria-busy", "false");
            for (const node of inputs) node.disabled = false;
          }
        }
      },
      { canSubmit: () => !!selection && !creating },
    );
    const generation = modal.generation,
      dialog = modal.element;
    dialog.classList.add("document-template-dialog");
    dialog.setAttribute("aria-busy", "false");
    const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!,
      search = get<HTMLInputElement>("#documentTemplateSearch"),
      choices = get("[data-picker-choices]"),
      more = get<HTMLButtonElement>("[data-picker-more]"),
      submit = get<HTMLButtonElement>('[type="submit"]'),
      current = () => generation === modal.generation && dialog.open;
    const notice = (text: string) => {
      if (current()) get("[data-picker-notice]").textContent = text;
    };
    const error = (reason: unknown) =>
      notice(errorText(reason instanceof PluginApiError ? reason.payload : null, t, "plugins.packageUnavailable"));
    const name = (entry: ManagedTemplate) => presentationText(t, entry.label, "name", document.documentElement.lang);
    const select = async (entry: ManagedTemplate) => {
      const ref = entry.reference;
      if (creating || ref.registry !== "portable") return;
      const preview = ++previews;
      selection = null;
      submit.disabled = true;
      get("[data-picker-fields]").replaceChildren();
      get<HTMLDetailsElement>("[data-picker-preview]").hidden = true;
      notice(t("documents.loading"));
      try {
        const reference = { id: ref.id, version: ref.version, digest: ref.digest },
          query = new URLSearchParams(reference),
          value = await portableTemplatesApi.preview(query);
        if (!current() || previews !== preview) return;
        if (value.model.kind !== "document")
          throw new PluginApiError(400, { messageId: "templates.unsupportedAuthoring" });
        selection = { reference, manifest: value.manifest, model: value.model };
        setMessageHtml(
          get("[data-picker-fields]"),
          `<h3>${e(name(entry))}</h3><p>${e(ref.version)}</p><label for="document-template-title">${e(t("documents.articleTitle"))}</label><input id="document-template-title" name="document-title" required maxlength="200" value="${e(t("documents.untitled"))}">${applicationFields(t, value.manifest, value.model)}`,
        );
        submit.disabled = false;
        notice("");
        for (const button of choices.querySelectorAll<HTMLButtonElement>("button"))
          button.setAttribute("aria-pressed", String(button.dataset.templateKey === entry.key));
        const details = get<HTMLDetailsElement>("[data-picker-preview]"),
          host = details.querySelector<HTMLElement>("div")!;
        details.hidden = false;
        let rendered = false;
        details.ontoggle = () => {
          if (!details.open || rendered) return;
          rendered = true;
          void templatePreviewImages(value.model, query)
            .then((images) => {
              if (current() && previews === preview) portableTemplatePreview(host, value.model, t, images);
            })
            .catch((reason) => {
              if (current() && previews === preview) {
                rendered = false;
                error(reason);
              }
            });
        };
        get<HTMLInputElement>("#document-template-title").focus({ preventScroll: true });
      } catch (reason) {
        if (current() && previews === preview) error(reason);
      }
    };
    const list = async (append = false) => {
      const read = ++reads,
        params = new URLSearchParams({
          registry: "portable",
          type: "panda.document-template",
          state: "enabled",
          search: search.value.trim(),
          limit: "30",
        });
      if (append && cursor) params.set("cursor", cursor);
      more.disabled = true;
      notice(t("documents.loading"));
      try {
        const page = await managedTemplatesApi.list(params);
        if (!current() || reads !== read) return;
        if (!append) choices.replaceChildren();
        for (const entry of page.templates) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "document-template-choice";
          button.disabled = creating;
          button.dataset.templateKey = entry.key;
          setMessageHtml(
            button,
            `<strong>${e(name(entry))}</strong><span>${e(presentationText(t, entry.label, "description", document.documentElement.lang))}</span><small>${e(entry.reference.version)} · ${e(entry.license || "")}</small>`,
          );
          button.onclick = () => {
            void select(entry);
          };
          choices.append(button);
        }
        cursor = page.nextCursor;
        more.hidden = !cursor;
        notice(page.total ? "" : t("templates.noDocumentTemplates"));
      } catch (reason) {
        if (current() && reads === read) error(reason);
      } finally {
        if (current() && reads === read) more.disabled = creating;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    search.oninput = () => {
      clearTimeout(timer);
      reads++;
      timer = setTimeout(() => {
        if (current()) void list();
      }, 250);
    };
    more.onclick = () => {
      if (cursor) void list(true);
    };
    localizeText(dialog.querySelector("h2"), "templates.createDocumentFromTemplate", undefined, t);
    localizeText(submit, "templates.createEditableDocument", undefined, t);
    void list();
    const result = await pending;
    clearTimeout(timer);
    return result;
  }
}
