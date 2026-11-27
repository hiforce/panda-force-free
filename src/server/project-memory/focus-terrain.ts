import type { MemoryEntry, MemoryTerrainPlace } from "../../shared/project-memory/contracts.js";
import type { MemoryEvidence } from "./records.js";
import { memorySourceIdentity, organizedMemoryLinks } from "./relations.js";

function add(index: Map<string, string[]>, key: string, id: string) {
  const values = index.get(key);
  if (values) values.push(id);
  else index.set(key, [id]);
}

export function memoryFocusPages(
  root: MemoryEntry,
  entries: readonly MemoryEntry[],
  groups: ReadonlyMap<string, MemoryEvidence[]>,
  hops: 1 | 2,
) {
  const active = new Map(entries.map((entry) => [entry.id, entry]));
  const explicit = new Map<string, string[]>();
  for (const [from, links] of organizedMemoryLinks(active, groups)) {
    for (const { to } of links) {
      add(explicit, from, to);
      add(explicit, to, from);
    }
  }
  const byTopic = new Map<string, string[]>();
  const bySource = new Map<string, string[]>();
  for (const entry of entries) {
    add(byTopic, entry.key, entry.id);
    for (const source of entry.sources) add(bySource, memorySourceIdentity(source), entry.id);
  }
  const seen = new Set([root.id]);
  const expandedTopics = new Set<string>();
  const expandedSources = new Set<string>();
  function expand(frontier: Iterable<string>) {
    const next = new Map<string, string>();
    function collect(parent: string, targets: readonly string[]) {
      for (const id of targets) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.set(id, parent);
      }
    }
    for (const id of frontier) collect(id, explicit.get(id) ?? []);
    for (const id of frontier) {
      const entry = active.get(id)!;
      if (!expandedTopics.has(entry.key)) {
        expandedTopics.add(entry.key);
        collect(id, byTopic.get(entry.key) ?? []);
      }
      for (const source of entry.sources) {
        const key = memorySourceIdentity(source);
        if (expandedSources.has(key)) continue;
        expandedSources.add(key);
        collect(id, bySource.get(key) ?? []);
      }
    }
    return next;
  }

  const direct = [...expand([root.id]).keys()];
  const byParent = new Map<string, string[]>();
  if (hops === 2) for (const [id, parent] of expand(direct)) add(byParent, parent, id);
  const pages: MemoryTerrainPlace[][] = [];
  const center: MemoryTerrainPlace = { slot: 0, entry: root, depth: 0 };
  const innerSize = byParent.size ? 3 : 5;
  for (let index = 0; index < direct.length; index += innerSize) {
    const inner = direct.slice(index, index + innerSize);
    const outer = inner.flatMap((id) => byParent.get(id) ?? []);
    const capacity = 5 - inner.length;
    for (let offset = 0; offset < Math.max(1, outer.length); offset += Math.max(1, capacity)) {
      const nodes: MemoryTerrainPlace[] = inner.map((id, slot) => ({
        slot: slot + 1,
        entry: active.get(id)!,
        depth: 1,
      }));
      for (const id of outer.slice(offset, offset + capacity))
        nodes.push({ slot: nodes.length + 1, entry: active.get(id)!, depth: 2 });
      pages.push([center, ...nodes]);
    }
  }
  return pages.length ? pages : [[center]];
}
