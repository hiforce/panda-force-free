import type { Translate } from "../../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml, messageHtml, messageAttributes } from "../../i18n.js";
import { codexIcon } from "../../codex-icons.js";
import { storage, STORAGE_KEYS } from "../../storage.js";
import { DocumentTreeIndex } from "./tree-model.js";

/** View preferences and focus are local. Metadata comes only from the navigation session. */
export class DocumentTreeView {
  expanded = new Set<string>();
  query = "";
  selected = "";
  private key = "";
  private selectionKey = "";
  private initialized = false;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private t: Translate,
    private identity: string,
  ) {}
  open(project: string) {
    this.cancelSearch();
    this.key = STORAGE_KEYS.documentTreeFor(this.identity, project);
    this.selectionKey = STORAGE_KEYS.documentSelectionFor(this.identity, project);
    const selected: unknown = storage.getSessionJson(this.selectionKey, "");
    this.selected = typeof selected === "string" && selected.length <= 128 ? selected : "";
    this.query = "";
    const value: unknown = storage.getSessionJson(this.key, null);
    this.initialized = Array.isArray(value);
    this.expanded = new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string" && id.length <= 128).slice(0, 5000)
        : [],
    );
  }
  search(query: string, render: () => void) {
    this.query = query;
    this.cancelSearch();
    this.searchTimer = setTimeout(render, 150);
  }
  cancelSearch() {
    clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
  }
  expand(id: string, open = true) {
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    this.persist();
  }
  remember(id: string) {
    this.selected = id;
    if (this.selectionKey) storage.setSessionJson(this.selectionKey, id);
  }
  reveal(index: DocumentTreeIndex, id: string) {
    for (const node of index.ancestors(id).slice(0, -1)) this.expanded.add(node.documentId);
    this.persist();
  }
  private persist() {
    if (this.key) storage.setSessionJson(this.key, [...this.expanded].slice(0, 5000));
  }
  render(host: HTMLElement, index: DocumentTreeIndex, selected: string, disabled: boolean) {
    if (!this.initialized && index.tree.nodes.length) {
      for (const node of index.children.get(null) || []) this.expanded.add(node.documentId);
      this.initialized = true;
      this.persist();
    }
    const top = host.scrollTop,
      active = document.activeElement;
    const focus =
      active instanceof HTMLElement && host.contains(active)
        ? { id: active.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId, action: active.dataset.treeAction }
        : null;
    const rows = index.visible(this.expanded, this.query),
      attr = disabled ? "disabled" : "";
    setMessageHtml(
      host,
      `<button type="button" class="document-tree-root" data-tree-action="root" data-tree-root>${codexIcon("folder")}<span>${messageHtml("documents.rootFolder", undefined, this.t)}</span></button><div role="tree" ${messageAttributes("aria-label", "documents.directory", undefined, this.t)}>${rows.map(({ node, level, expanded, childCount }) => `<div class="document-tree-row${selected === node.documentId ? " selected" : ""}" role="treeitem" aria-level="${level}" aria-selected="${selected === node.documentId}" ${childCount ? `aria-expanded="${expanded}"` : ""} data-tree-id="${e(node.documentId)}" style="--tree-level:${Math.min(level, 12)}"><button type="button" class="document-tree-expand" data-tree-action="toggle" ${messageAttributes("aria-label", expanded ? "documents.collapseNode" : "documents.expandNode", { title: node.document.title }, this.t)} ${childCount ? "" : "disabled"}>${childCount ? codexIcon("chevronRight") : ""}</button><button type="button" class="document-tree-title" data-tree-action="select" data-id="${e(node.documentId)}" title="${e(index.path(node.documentId))}" ${selected === node.documentId ? 'aria-current="page"' : ""}>${codexIcon("file")}<span>${e(node.document.title)}</span></button><button type="button" class="document-tree-handle" data-tree-action="move" ${messageAttributes("aria-label", "documents.moveNode", { title: node.document.title }, this.t)} ${attr}>⠿</button><button type="button" class="document-tree-more" data-tree-action="menu" ${messageAttributes("aria-label", "documents.nodeActions", { title: node.document.title }, this.t)} ${attr}>${codexIcon("ellipsis")}</button></div>`).join("")}</div>${rows.length ? "" : `<p class="document-tree-empty">${messageHtml(this.query ? "documents.noTreeResults" : "documents.noDocuments", undefined, this.t)}</p>`}<div class="document-tree-root-drop" data-tree-root>${messageHtml("documents.moveToRootHint", undefined, this.t)}</div>`,
    );
    host.scrollTop = top;
    if (focus?.id) {
      const row = [...host.querySelectorAll<HTMLElement>("[data-tree-id]")].find(
        (node) => node.dataset.treeId === focus.id,
      );
      row
        ?.querySelector<HTMLButtonElement>(`[data-tree-action="${focus.action || "select"}"]`)
        ?.focus({ preventScroll: true });
    }
  }
}
