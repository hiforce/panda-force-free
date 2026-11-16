import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeCatalog, KnowledgeReadScope } from "../catalog/contracts.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { knowledgeId } from "../../../shared/knowledge/primitives.js";
import { projectKnowledgeFile } from "../../project-content/paths.js";
import { knowledgeRecord } from "../tasks/record.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
/** Saved records select primary workflow identities; their own hashes never grant admission. */
export async function selectedKnowledgeCatalog(
  catalog: MetadataStore<KnowledgeCatalog>,
  scope: KnowledgeReadScope,
  view: ProjectContentView | null,
  ids: readonly string[],
  originals: Map<string, Buffer>,
) {
  const requested = new Set(ids.map(knowledgeId));
  if (!view) return { entries: [], incomplete: false, missing: [] };
  const taskIds = new Set<string>();
  let bytes = 0;
  for (const id of requested) {
    const path = projectKnowledgeFile(id);
    if (!view.version(path)) continue;
    const original = await view.read(path);
    if (!original) throw new KnowledgeTaskError("unavailable");
    bytes += original.length;
    if (bytes > 32 * 1024 * 1024) throw new KnowledgeTaskError("budget");
    const record = knowledgeRecord(JSON.parse(original.toString("utf8")));
    if (record.id !== id) throw new KnowledgeTaskError("unavailable");
    taskIds.add(record.taskId);
    originals.set(id, original);
  }
  const found = await catalog.lookup(scope.owner, scope.project, [...taskIds]);
  // A forged file may point to a real task belonging to a different knowledge record.
  return { ...found, entries: found.entries.filter((entry) => requested.has(entry.projection.id)) };
}
