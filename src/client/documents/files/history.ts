import type { Translate } from "../../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml } from "../../i18n.js";
import { DocumentModal } from "../modal.js";
import { richDocumentReader } from "../rich-reader.js";
import type { fileDocumentApi } from "./api.js";

/** History reads immutable originals; restoring is a separate guarded editor command. */
export async function fileHistory(t: Translate, modal: DocumentModal, api: ReturnType<typeof fileDocumentApi>) {
  const initial = modal.generation,
    { revisions } = await api.history();
  if (modal.generation !== initial) return null;
  const result = modal.form(
    t("documents.history"),
    `<p>${e(t("documents.historyHint"))}</p><select name="document-revision" id="documentRevisionSelect" aria-label="${e(t("documents.history"))}">${revisions.map((r) => `<option value="${e(r.id)}">${e(t("documents.revision", { number: r.number }))} · ${e(r.title)}</option>`).join("")}</select><div id="documentRevisionPreview" class="document-revision-rich" aria-live="polite"></div>`,
    t("documents.restore"),
    async (fields) => fields.revision!,
  );
  const epoch = modal.generation,
    select = modal.element.querySelector<HTMLSelectElement>("select")!,
    host = modal.element.querySelector<HTMLElement>("#documentRevisionPreview")!;
  async function update() {
    const id = select.value;
    host.textContent = t("documents.loading");
    try {
      const { revision } = await api.revision(id);
      if (epoch !== modal.generation || id !== select.value) return;
      if (revision.body) host.replaceChildren(richDocumentReader(revision.body, t("documents.preview"), api.imageUrl));
      else {
        const pre = document.createElement("pre");
        pre.textContent = revision.content;
        host.replaceChildren(pre);
      }
    } catch {
      if (epoch === modal.generation) setMessageHtml(host, `<p>${e(t("documents.unavailable"))}</p>`);
    }
  }
  select.onchange = () => void update();
  void update();
  return result;
}
