import { warmRichEditor } from "../../documents/rich-loader.js";
import type { Translate } from "../../../shared/i18n/messages.js";
import type { TemplateNativeReference } from "../../../shared/templates/catalog.js";
import type { TemplateDraftRecord } from "../../../shared/templates/authoring/contracts.js";
import { emptyDocumentTemplate } from "../../../shared/templates/authoring/defaults.js";
import { setMessageHtml, errorText } from "../../i18n.js";

import { PluginApiError } from "../../plugins/api.js";
import { DocumentApiError } from "../../documents/api.js";
import { DocumentModal } from "../../documents/modal.js";
import { DocumentTemplateEditor } from "./editor.js";
import { templateAuthoringApi as api } from "./api.js";
import { draftLibraryFrame } from "./views.js";
import { escapeHtml as e } from "../../../shared/html.js";

/** The owned draft library coordinates navigation; editing and installed-template lifecycle remain separate. */
export function createTemplateAuthoring(
  t: Translate,
  identity: string,
  changed: () => void,
  report: (error: unknown) => void,
  creatingState: (busy: boolean) => void,
) {
  const editor = new DocumentTemplateEditor(t, identity, changed),
    confirm = new DocumentModal(t, "templateDraftConfirmation"),
    dialog = document.createElement("dialog");
  dialog.id = "templateDraftLibrary";
  dialog.className = "package-dialog template-draft-library";
  dialog.setAttribute("aria-labelledby", "templateDraftLibraryTitle");
  document.body.append(dialog);
  let epoch = 0,
    busy = false,
    creatingBusy = false,
    drafts: TemplateDraftRecord[] = [];
  let creating: {
    operationId: string;
    id: string;
    expectedRevision: number;
    templateType: string;
    definition: ReturnType<typeof emptyDocumentTemplate>;
  } | null = null;
  function closeLibrary() {
    epoch++;
    busy = false;
    confirm.close();
    dialog.close();
    dialog.replaceChildren();
    drafts = [];
  }
  function controls() {
    dialog.setAttribute("aria-busy", String(busy));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = busy && button.dataset.draftAction !== "close";
  }
  function notice(error: unknown) {
    const node = dialog.querySelector("[data-draft-notice]");
    if (node)
      node.textContent = errorText(
        error instanceof PluginApiError ? error.payload : null,
        t,
        "plugins.packageUnavailable",
      );
  }
  async function load() {
    const generation = epoch;
    busy = true;
    controls();
    try {
      const value = await api.list();
      if (generation !== epoch) return;
      drafts = value.drafts;
      setMessageHtml(dialog, draftLibraryFrame(t, drafts));
    } catch (error) {
      if (generation === epoch) notice(error);
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeLibrary();
  });
  dialog.onclick = (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-draft-action]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.draftAction;
    if (action === "close") return closeLibrary();
    if (action === "refresh") return void load();
    const draft = drafts.find((item) => item.id === button.dataset.draftId);
    if (!draft || busy) return;
    const generation = epoch;
    busy = true;
    controls();
    void (async () => {
      if (action === "open") {
        warmRichEditor();
        const detail = await api.detail(draft.id);
        if (generation === epoch) {
          closeLibrary();
          editor.open(detail);
        }
      }
      if (action === "remove") {
        const operationId = crypto.randomUUID();
        const removed = await confirm.form(
          t("templates.removeDraft"),
          `<p>${e(t("templates.removeDraftHint"))}</p>`,
          t("templates.removeDraft"),
          async () => {
            try {
              await api.remove(draft, operationId);
              return true;
            } catch (error) {
              if (error instanceof PluginApiError) throw new DocumentApiError(error.status, error.payload);
              throw error;
            }
          },
          { tone: "danger" },
        );
        if (removed && generation === epoch) await load();
      }
    })()
      .catch((error) => {
        if (generation === epoch) notice(error);
      })
      .finally(() => {
        if (generation === epoch) {
          busy = false;
          controls();
        }
      });
  };
  return {
    get creating() {
      return creatingBusy;
    },
    close() {
      closeLibrary();
      editor.close(true);
    },
    library() {
      if (!editor.close()) return;
      closeLibrary();
      setMessageHtml(dialog, draftLibraryFrame(t, []));
      dialog.showModal();
      void load();
    },
    async create() {
      if (creatingBusy || !editor.close()) return;
      warmRichEditor();
      const generation = epoch;
      creatingBusy = true;
      creatingState(true);
      creating ||= {
        operationId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        expectedRevision: 0,
        templateType: "panda.document-template",
        definition: emptyDocumentTemplate("custom.article-" + crypto.randomUUID().slice(0, 8)),
      };
      try {
        const result = await api.create(creating);
        creating = null;
        if (generation === epoch && result.current) editor.open(result.current);
      } catch (error) {
        report(error);
      } finally {
        creatingBusy = false;
        creatingState(false);
      }
    },
    async fork(reference: TemplateNativeReference) {
      const result = await api.fork(crypto.randomUUID(), crypto.randomUUID(), reference);
      if (!result.current) throw new PluginApiError(404, { messageId: "templates.draftNotFound" });
      const detail = result.current;
      return () => editor.open(detail);
    },
  };
}
