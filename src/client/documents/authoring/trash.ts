import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentTreeTrashItem, DocumentTreeMutation } from "../../../shared/documents/navigation.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml, messageHtml } from "../../i18n.js";
import { documentTreeTrash } from "./tree-api.js";
import type { DocumentTreeSession } from "./tree-session.js";

/** Keyset pages stay bound to their own view and expose explicit progress without hydrating deleted bodies. */
export class DocumentTreeTrash {
  private epoch = 0;
  private cursor: string | null = null;
  private items: DocumentTreeTrashItem[] = [];
  private host: HTMLElement | null = null;
  private busy = false;
  constructor(
    private t: Translate,
    private session: DocumentTreeSession,
    private restored: (result: DocumentTreeMutation) => Promise<void>,
    private error: (reason: unknown) => void,
  ) {}
  close() {
    this.epoch++;
    this.host = null;
    this.items = [];
    this.cursor = null;
    this.busy = false;
  }
  async show(host: HTMLElement) {
    this.close();
    this.host = host;
    await this.load(false);
  }
  private draw() {
    if (!this.host) return;
    const positions: { node: HTMLElement; top: number }[] = [];
    for (let node: HTMLElement | null = this.host; node; node = node.parentElement)
      if (node.scrollTop) positions.push({ node, top: node.scrollTop });
    setMessageHtml(
      this.host,
      `<div class="document-trash"><h2>${messageHtml("documents.trash", undefined, this.t)}</h2>${this.items.map(({ document, subtreeCount }) => `<article><div><strong>${e(document.title)}</strong><small>${messageHtml("documents.deletedBranchCount", { count: subtreeCount }, this.t)}</small></div><button type="button" class="wb-button" data-trash-restore="${e(document.id)}" ${this.busy ? "disabled" : ""}>${messageHtml("documents.restoreDocument", undefined, this.t)}</button></article>`).join("")}${!this.items.length && !this.busy ? `<p>${messageHtml("documents.emptyTrash", undefined, this.t)}</p>` : ""}${this.busy ? `<p role="status">${messageHtml("documents.loading", undefined, this.t)}</p>` : ""}${this.cursor ? `<button type="button" class="wb-button" data-trash-more ${this.busy ? "disabled" : ""}>${messageHtml("documents.more", undefined, this.t)}</button>` : ""}</div>`,
    );
    this.host
      .querySelector<HTMLButtonElement>("[data-trash-more]")
      ?.addEventListener("click", () => void this.load(true).catch(this.error));
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-trash-restore]")
      .forEach((button) => (button.onclick = () => void this.restore(button.dataset.trashRestore!).catch(this.error)));
    for (const { node, top } of positions) node.scrollTop = top;
  }
  private async load(append: boolean) {
    if (this.busy || !this.host) return;
    const epoch = this.epoch,
      project = this.session.snapshot.projectId;
    this.busy = true;
    this.draw();
    try {
      const page = await documentTreeTrash(project, append ? this.cursor || undefined : undefined);
      if (epoch !== this.epoch) return;
      this.items = append
        ? [...new Map([...this.items, ...page.documents].map((item) => [item.document.id, item])).values()]
        : page.documents;
      this.cursor = page.nextCursor;
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.draw();
      }
    }
  }
  private async restore(documentId: string) {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.draw();
    try {
      const result = await this.session.mutate({ kind: "restore", documentId });
      if (epoch === this.epoch && result) await this.restored(result);
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.draw();
      }
    }
  }
}
