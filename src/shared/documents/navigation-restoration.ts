import type { DocumentTreePlacement } from "./navigation.js";
import { documentSubtree } from "./navigation.js";
import { insertTreeNodes } from "./navigation-structure.js";

/** Restore only the selected deleted branch. A missing saved parent becomes a visible root. */
export function planTreeRestore(
  base: DocumentTreePlacement[],
  tombstones: DocumentTreePlacement[],
  documentId: string,
  toRoot: boolean,
) {
  const saved = new Set(tombstones.map((node) => node.documentId));
  const selected = saved.has(documentId)
    ? documentSubtree(
        tombstones.map((node) => ({
          ...node,
          parentId: node.parentId && saved.has(node.parentId) ? node.parentId : null,
        })),
        documentId,
      )
    : [documentId];
  const selectedIds = new Set(selected),
    active = new Set(base.map((node) => node.documentId));
  const placements = new Map(tombstones.map((node) => [node.documentId, node]));
  let restoredToRoot = false;
  const additions = selected.map((id) => {
    const previous = placements.get(id);
    let parentId = previous?.parentId ?? null;
    if (id === documentId && (toRoot || (parentId !== null && !active.has(parentId)))) {
      restoredToRoot = parentId !== null;
      parentId = null;
    }
    if (parentId !== null && !selectedIds.has(parentId) && !active.has(parentId)) parentId = null;
    return {
      documentId: id,
      parentId,
      position: previous?.position ?? base.filter((node) => node.parentId === null).length,
    };
  });
  const next = insertTreeNodes(base, additions);
  return { selected, additions, next, restoredToRoot };
}
