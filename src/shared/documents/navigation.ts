import type { DocumentRecord } from "./contracts.js";

/** Navigation is independent of source paths and immutable content revisions. Every node is a document. */
export interface DocumentTreePlacement {
  documentId: string;
  parentId: string | null;
  position: number;
}
export type DocumentTreeTarget = { kind: "root" } | { kind: "before" | "after" | "inside"; documentId: string };
export interface ProjectDocumentTree {
  projectId: string;
  version: number;
  nodes: (DocumentTreePlacement & { document: DocumentRecord })[];
}
export interface DocumentTreeReceipt {
  id: string;
  documentId: string;
  affectedDocumentIds: string[];
  treeVersion: number;
  restoredToRoot: boolean;
}
export interface DocumentTreeMutation {
  tree: ProjectDocumentTree;
  operation: DocumentTreeReceipt;
}
export interface DocumentTreeTrashItem {
  document: DocumentRecord;
  deletedAt: number;
  subtreeCount: number;
}
export interface DocumentTreeTrashPage {
  documents: DocumentTreeTrashItem[];
  nextCursor: string | null;
}
export const DOCUMENT_TREE_LIMITS = { documents: 5000, depth: 32 };
export class DocumentTreeError extends Error {
  constructor(readonly code: "missing" | "invalid" | "cycle" | "depth" | "limit") {
    super(code);
  }
}

/** The same topology policy serves trusted application operations and browser drag previews. */
export function validateDocumentTree(nodes: readonly DocumentTreePlacement[]): void {
  if (nodes.length > DOCUMENT_TREE_LIMITS.documents) throw new DocumentTreeError("limit");
  const known = new Map(nodes.map((node) => [node.documentId, node]));
  if (known.size !== nodes.length) throw new DocumentTreeError("invalid");
  for (const node of nodes) {
    if (
      !node.documentId ||
      !Number.isSafeInteger(node.position) ||
      node.position < 0 ||
      (node.parentId !== null && !known.has(node.parentId))
    )
      throw new DocumentTreeError("invalid");
    const ancestors = new Set<string>();
    let current: DocumentTreePlacement | undefined = node;
    while (current) {
      if (ancestors.has(current.documentId)) throw new DocumentTreeError("cycle");
      ancestors.add(current.documentId);
      if (ancestors.size > DOCUMENT_TREE_LIMITS.depth) throw new DocumentTreeError("depth");
      current = current.parentId === null ? undefined : known.get(current.parentId);
    }
  }
}
const order = (a: DocumentTreePlacement, b: DocumentTreePlacement) =>
  a.position - b.position || a.documentId.localeCompare(b.documentId, "en");

/** Reparent one root, retain its descendants, and compact only the two affected sibling lists. */
export function moveDocumentTree(
  nodes: readonly DocumentTreePlacement[],
  documentId: string,
  target: DocumentTreeTarget,
): DocumentTreePlacement[] {
  validateDocumentTree(nodes);
  const next = nodes.map((node) => ({ ...node })),
    known = new Map(next.map((node) => [node.documentId, node])),
    moving = known.get(documentId);
  if (!moving) throw new DocumentTreeError("missing");
  const anchor = target.kind === "root" ? null : known.get(target.documentId);
  if (target.kind !== "root" && !anchor) throw new DocumentTreeError("missing");
  if (anchor === moving && target.kind !== "inside") return next;
  const oldParent = moving.parentId,
    parentId = target.kind === "root" ? null : target.kind === "inside" ? anchor!.documentId : anchor!.parentId;
  const siblings = next.filter((node) => node.documentId !== documentId && node.parentId === parentId).sort(order);
  const index =
    target.kind === "before" || target.kind === "after"
      ? siblings.findIndex((node) => node.documentId === anchor!.documentId) + (target.kind === "after" ? 1 : 0)
      : siblings.length;
  moving.parentId = parentId;
  siblings.splice(index, 0, moving);
  siblings.forEach((node, position) => {
    node.position = position;
  });
  if (oldParent !== parentId)
    next
      .filter((node) => node.documentId !== documentId && node.parentId === oldParent)
      .sort(order)
      .forEach((node, position) => {
        node.position = position;
      });
  validateDocumentTree(next);
  return next;
}

export function documentSubtree(nodes: readonly DocumentTreePlacement[], documentId: string): string[] {
  validateDocumentTree(nodes);
  if (!nodes.some((node) => node.documentId === documentId)) throw new DocumentTreeError("missing");
  const children = new Map<string | null, string[]>();
  for (const node of nodes) {
    let list = children.get(node.parentId);
    if (!list) {
      list = [];
      children.set(node.parentId, list);
    }
    list.push(node.documentId);
  }
  const result = [documentId];
  for (let index = 0; index < result.length; index++) result.push(...(children.get(result[index]!) || []));
  return result;
}
