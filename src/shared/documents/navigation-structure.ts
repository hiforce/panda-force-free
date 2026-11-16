import type { DocumentTreePlacement } from "./navigation.js";
import { validateDocumentTree } from "./navigation.js";

const order = (a: DocumentTreePlacement, b: DocumentTreePlacement) =>
  a.position - b.position || a.documentId.localeCompare(b.documentId, "en");
/** Restored siblings return to their saved slots; existing nodes retain relative order. */
export function insertTreeNodes(
  base: DocumentTreePlacement[],
  additions: DocumentTreePlacement[],
): DocumentTreePlacement[] {
  validateDocumentTree([...base, ...additions]);
  const groups = new Map<string | null, DocumentTreePlacement[]>(),
    all = [...base, ...additions].map((node) => ({ ...node }));
  const byId = new Map(all.map((node) => [node.documentId, node]));
  for (const node of base) {
    const list = groups.get(node.parentId) || [];
    list.push(byId.get(node.documentId)!);
    groups.set(node.parentId, list);
  }
  for (const list of groups.values()) list.sort(order);
  for (const node of [...additions].sort(order)) {
    const list = groups.get(node.parentId) || [];
    list.splice(Math.min(node.position, list.length), 0, byId.get(node.documentId)!);
    groups.set(node.parentId, list);
  }
  for (const list of groups.values())
    list.forEach((node, position) => {
      node.position = position;
    });
  validateDocumentTree(all);
  return all;
}
/** Legacy single-document deletion lifts surviving children instead of hiding or deleting them. */
export function liftRemovedNodes(nodes: DocumentTreePlacement[], removed: Set<string>): DocumentTreePlacement[] {
  validateDocumentTree(nodes);
  const known = new Map(nodes.map((node) => [node.documentId, node])),
    groups = new Map<string | null, DocumentTreePlacement[]>();
  for (const node of nodes) {
    const list = groups.get(node.parentId) || [];
    list.push(node);
    groups.set(node.parentId, list);
  }
  for (const list of groups.values()) list.sort(order);
  const ordered: DocumentTreePlacement[] = [],
    pending = [...(groups.get(null) || [])].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    ordered.push(node);
    pending.push(...[...(groups.get(node.documentId) || [])].reverse());
  }
  const counts = new Map<string | null, number>();
  const result = ordered
    .filter((node) => !removed.has(node.documentId))
    .map((node) => {
      let parentId = node.parentId;
      while (parentId !== null && removed.has(parentId)) parentId = known.get(parentId)!.parentId;
      const position = counts.get(parentId) || 0;
      counts.set(parentId, position + 1);
      return { documentId: node.documentId, parentId, position };
    });
  validateDocumentTree(result);
  return result;
}
