import type { ProjectDocumentTree, DocumentTreeTarget } from "../../../shared/documents/navigation.js";
import { moveDocumentTree, validateDocumentTree, DOCUMENT_TREE_LIMITS } from "../../../shared/documents/navigation.js";

export type TreeNode = ProjectDocumentTree["nodes"][number];
/** Derived navigation never infers parentage from content paths or owns editor source. */
export class DocumentTreeIndex {
  readonly byId: Map<string, TreeNode>;
  readonly children = new Map<string | null, TreeNode[]>();
  private moves = new Map<string, boolean>();
  constructor(readonly tree: ProjectDocumentTree) {
    validateDocumentTree(tree.nodes);
    this.byId = new Map(tree.nodes.map((node) => [node.documentId, node]));
    for (const node of tree.nodes) {
      const siblings = this.children.get(node.parentId) || [];
      siblings.push(node);
      this.children.set(node.parentId, siblings);
    }
    for (const siblings of this.children.values())
      siblings.sort((a, b) => a.position - b.position || a.documentId.localeCompare(b.documentId, "en"));
  }
  ancestors(id: string): TreeNode[] {
    const result: TreeNode[] = [];
    let node = this.byId.get(id);
    while (node) {
      result.unshift(node);
      node = node.parentId ? this.byId.get(node.parentId) : undefined;
    }
    return result;
  }
  path(id: string) {
    return this.ancestors(id)
      .map((node) => node.document.title)
      .join(" / ");
  }
  visible(expanded: ReadonlySet<string>, query = "") {
    const needle = query.trim().toLocaleLowerCase().slice(0, 250),
      included = new Set<string>();
    if (needle)
      for (const node of this.tree.nodes)
        if (this.path(node.documentId).toLocaleLowerCase().includes(needle))
          for (const parent of this.ancestors(node.documentId)) included.add(parent.documentId);
    const rows: { node: TreeNode; level: number; expanded: boolean; childCount: number }[] = [];
    const walk = (parentId: string | null, level: number) => {
      for (const node of this.children.get(parentId) || []) {
        if (needle && !included.has(node.documentId)) continue;
        const childCount = this.children.get(node.documentId)?.length || 0,
          open = !!childCount && (!!needle || expanded.has(node.documentId));
        rows.push({ node, level, expanded: open, childCount });
        if (open) walk(node.documentId, level + 1);
      }
    };
    walk(null, 1);
    return rows;
  }
  canMove(id: string, target: DocumentTreeTarget) {
    const key = JSON.stringify([id, target]);
    if (this.moves.has(key)) return this.moves.get(key)!;
    let valid = false;
    try {
      moveDocumentTree(this.tree.nodes, id, target);
      valid = !(target.kind !== "root" && target.documentId === id);
    } catch {}
    this.moves.set(key, valid);
    return valid;
  }
  parents(id: string) {
    const excluded = new Set<string>(),
      pending = [{ id, depth: 1 }];
    let height = 1;
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]!;
      excluded.add(entry.id);
      height = Math.max(height, entry.depth);
      for (const child of this.children.get(entry.id) || [])
        pending.push({ id: child.documentId, depth: entry.depth + 1 });
    }
    return this.tree.nodes.filter(
      (node) =>
        !excluded.has(node.documentId) && this.ancestors(node.documentId).length + height <= DOCUMENT_TREE_LIMITS.depth,
    );
  }
}
