import type { Translate, MessageId } from "../../../shared/i18n/messages.js";
import { localizeText, messageHtml } from "../../i18n.js";
import {
  documentSubtree,
  type DocumentTreeMutation,
  type DocumentTreeTarget,
} from "../../../shared/documents/navigation.js";
import { DocumentApiError } from "../api.js";
import type { DocumentModal } from "../modal.js";
import { field } from "../views.js";
import { DocumentTreeIndex } from "./tree-model.js";
import type { DocumentTreeSession } from "./tree-session.js";
import type { TreeIntent } from "./tree-api.js";
import type { TreeMenuAction } from "./tree-menu.js";

/** Forms translate intent; the navigation session alone owns transport, versioning and retry. */
export class DocumentTreeActions {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
    private session: DocumentTreeSession,
    private canChange: (ids: string[]) => boolean,
    private completed: (result: DocumentTreeMutation, kind: string) => Promise<void>,
  ) {}
  private async mutate(intent: TreeIntent, version?: number) {
    try {
      return await this.session.mutate(intent, version);
    } catch (error) {
      // Recovery belongs to the workspace; an uncertain form must not obscure its retry control.
      if (this.session.pending) this.modal.close();
      throw error;
    }
  }
  private localizeForm(title: MessageId, submit: MessageId) {
    localizeText(this.modal.element.querySelector("h2"), title, undefined, this.t);
    localizeText(this.modal.element.querySelector('[type="submit"]'), submit, undefined, this.t);
  }
  async run(kind: Exclude<TreeMenuAction, "new-child-template">, id: string) {
    if (this.session.busy || this.session.pending) return;
    if (kind === "new-child") return this.create(id);
    const node = new DocumentTreeIndex(this.session.snapshot).byId.get(id);
    if (!node) return;
    if (kind === "move") return this.moveDialog(id);
    if (!this.canChange([id])) throw new DocumentApiError(409, { messageId: "documents.saveBeforeTreeChange" });
    if (kind === "rename") {
      const pending = this.modal.form(
        this.t("documents.renameNode"),
        field(this.t, "documents.articleTitle", "title", node.document.title, 'required maxlength="200"'),
        this.t("documents.save"),
        async (fields) => {
          if (!this.canChange([id])) throw new DocumentApiError(409, { messageId: "documents.saveBeforeTreeChange" });
          const result = await this.mutate({
            kind: "rename",
            documentId: id,
            title: fields.title!,
            revision: node.document.revision,
          });
          if (result) await this.completed(result, "rename");
          return result;
        },
      );
      this.localizeForm("documents.renameNode", "documents.save");
      await pending;
      return;
    }
    const ids = documentSubtree(this.session.snapshot.nodes, id),
      version = this.session.snapshot.version;
    if (!this.canChange(ids)) throw new DocumentApiError(409, { messageId: "documents.saveBeforeTreeChange" });
    const pending = this.modal.form(
      this.t("documents.deleteDocument"),
      `<p>${messageHtml("documents.deleteSubtreeHint", { title: node.document.title, count: ids.length }, this.t)}</p>`,
      this.t("documents.deleteDocument"),
      async () => {
        if (!this.canChange(documentSubtree(this.session.snapshot.nodes, id)))
          throw new DocumentApiError(409, { messageId: "documents.saveBeforeTreeChange" });
        const result = await this.mutate({ kind: "trash", documentId: id, revision: node.document.revision }, version);
        if (result) await this.completed(result, "trash");
        return result;
      },
      { tone: "danger" },
    );
    this.localizeForm("documents.deleteDocument", "documents.deleteDocument");
    await pending;
  }
  async create(parentId: string | null) {
    const result = await this.mutate({
      kind: "create",
      title: this.t("documents.untitled"),
      parentId,
      locale: document.documentElement.lang || "en",
    });
    if (result) await this.completed(result, "create");
  }
  async move(id: string, target: DocumentTreeTarget) {
    const result = await this.mutate({ kind: "move", documentId: id, target });
    if (result) await this.completed(result, "move");
  }
  private async moveDialog(id: string) {
    let destination: string | null = null;
    const body = `<label for="documentMoveSearch">${messageHtml("documents.searchLocation", undefined, this.t)}</label><input id="documentMoveSearch" type="search" autocomplete="off"><div id="documentMoveOptions" class="document-move-options"></div><p class="document-move-hint">${messageHtml("documents.searchLocationHint", undefined, this.t)}</p>`;
    const pending = this.modal.form(
      this.t("documents.moveDocument"),
      body,
      this.t("documents.moveDocument"),
      async () => {
        await this.move(id, destination ? { kind: "inside", documentId: destination } : { kind: "root" });
        return true;
      },
    );
    this.localizeForm("documents.moveDocument", "documents.moveDocument");
    const input = this.modal.element.querySelector<HTMLInputElement>("#documentMoveSearch")!,
      options = this.modal.element.querySelector<HTMLElement>("#documentMoveOptions")!;
    const render = () => {
      const index = new DocumentTreeIndex(this.session.snapshot),
        needle = input.value.toLocaleLowerCase();
      const candidates = index
        .parents(id)
        .filter((node) => index.path(node.documentId).toLocaleLowerCase().includes(needle))
        .slice(0, 100);
      options.replaceChildren();
      const entries: [string, string][] = [
        ["", this.t("documents.rootFolder")],
        ...candidates.map((node) => [node.documentId, index.path(node.documentId)] as [string, string]),
      ];
      for (const [value, label] of entries) {
        const row = document.createElement("label"),
          radio = document.createElement("input"),
          text = document.createElement("span");
        radio.type = "radio";
        radio.name = "move-parent";
        radio.value = value;
        radio.checked = (destination || "") === value;
        radio.onchange = () => {
          destination = value || null;
        };
        if (value) text.textContent = label;
        else localizeText(text, "documents.rootFolder", undefined, this.t);
        row.append(radio, text);
        options.append(row);
      }
    };
    input.oninput = render;
    render();
    input.focus({ preventScroll: true });
    await pending;
  }
}
