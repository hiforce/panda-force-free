import type { KnowledgeGenerationSelection } from "../../../shared/knowledge/generation.js";
import { GENERATION_LIMITS } from "../../../shared/knowledge/generation.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { GenerationSnapshot } from "./contracts.js";

/** One bounded tree traversal carries subtree inclusion/exclusion; individual exclusions do not hide children. */
export function generationMatches(snapshot: GenerationSnapshot, selection: KnowledgeGenerationSelection) {
  const nodes = snapshot.documents;
  if (nodes.length > GENERATION_LIMITS.documents) throw new KnowledgeTaskError("budget");
  const children = new Map<string | null, typeof nodes>(),
    seen = new Set<string>(),
    documents = new Set(selection.documents),
    subtrees = new Set(selection.subtrees),
    excluded = new Set(selection.excludeDocuments),
    excludedTrees = new Set(selection.excludeSubtrees);
  for (const node of nodes) {
    if (seen.has(node.id)) throw new KnowledgeTaskError("conflict");
    seen.add(node.id);
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const queue = (children.get(null) ?? []).map((node) => ({ node, included: selection.all, excluded: false })),
    result: typeof nodes = [];
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i]!,
      node = entry.node,
      included = entry.included || subtrees.has(node.id),
      blocked = entry.excluded || excludedTrees.has(node.id);
    visited++;
    if (!blocked && !excluded.has(node.id) && (included || documents.has(node.id))) result.push(node);
    for (const child of children.get(node.id) ?? []) queue.push({ node: child, included, excluded: blocked });
  }
  if (visited !== nodes.length) throw new KnowledgeTaskError("conflict");
  return result;
}
