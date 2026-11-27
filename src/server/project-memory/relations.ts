import type {
  MemoryEntry,
  MemoryTerrain,
  MemoryTerrainLink,
  OrganizedMemoryRelationKind,
} from "../../shared/project-memory/contracts.js";
import { compareMemoryOrder, entryVersion, type MemoryEvidence } from "./records.js";

const rank: Record<MemoryTerrainLink["kind"], number> = {
  dependsOn: 0,
  refines: 0,
  related: 1,
  sameTopic: 2,
  sameSource: 3,
};
export const memorySourceIdentity = ({ conversationId, messageId }: MemoryEntry["sources"][number]) =>
  JSON.stringify([conversationId, messageId]);

type DirectedLink = Pick<MemoryTerrainLink, "to" | "source"> & { kind: OrganizedMemoryRelationKind };

export function organizedMemoryLinks(
  active: ReadonlyMap<string, MemoryEntry>,
  groups: ReadonlyMap<string, MemoryEvidence[]>,
) {
  const outgoing = new Map<string, DirectedLink[]>();
  for (const [from, source] of active) {
    const versions = new Map<string, { row: MemoryEvidence; kind: OrganizedMemoryRelationKind | "unlink" }>();
    for (const row of groups.get(from) ?? []) {
      if (!row.relations?.length || entryVersion(from, row.projectedFrom ?? row.value) !== source.version) continue;
      for (const { target, targetVersion, kind } of row.relations) {
        const prior = versions.get(target);
        if (active.get(target)?.version === targetVersion && (!prior || compareMemoryOrder(row, prior.row) > 0))
          versions.set(target, { row, kind });
      }
    }
    const links = [...versions].flatMap(([to, { kind, row }]) => {
      if (kind === "unlink" || !row.conversationId) return [];
      const source = { conversationId: row.conversationId, messageId: row.messageId };
      return [{ to, kind, source }];
    });
    if (links.length) outgoing.set(from, links);
  }
  return outgoing;
}

export function memoryTerrainRelations(
  places: MemoryTerrain["places"],
  entries: readonly MemoryEntry[],
  groups: ReadonlyMap<string, MemoryEvidence[]>,
): Pick<MemoryTerrain, "links" | "related"> {
  const visible = new Set(places.map(({ entry }) => entry.id));
  const active = new Map(entries.filter(({ state }) => state === "active").map((entry) => [entry.id, entry]));
  const pairs = new Map<string, MemoryTerrainLink>();
  const add = (link: MemoryTerrainLink) => {
    const { from, to, kind } = link;
    const pair = from < to ? from + to : to + from;
    const prior = pairs.get(pair);
    if (!prior || rank[kind] < rank[prior.kind]) pairs.set(pair, link);
  };

  for (const [from, links] of organizedMemoryLinks(active, groups)) {
    for (const link of links) {
      if (visible.has(from) || visible.has(link.to)) add({ from, ...link });
    }
  }

  for (const { entry: from } of places) {
    const sources = new Set(from.sources.map(memorySourceIdentity));
    for (const to of active.values()) {
      if (from.id === to.id) continue;
      if (from.key === to.key) add({ from: from.id, to: to.id, kind: "sameTopic" });
      else {
        const source = to.sources.find((source) => sources.has(memorySourceIdentity(source)));
        if (source) add({ from: from.id, to: to.id, kind: "sameSource", source });
      }
    }
  }

  const links: MemoryTerrainLink[] = [];
  const related = new Map<string, MemoryTerrain["related"][number]>();
  const offPageCount = new Map<string, number>();
  for (const link of [...pairs.values()].sort((a, b) => rank[a.kind] - rank[b.kind])) {
    if (!visible.has(link.from) || !visible.has(link.to)) {
      const [shown, hidden] = visible.has(link.from) ? [link.from, link.to] : [link.to, link.from];
      const count = offPageCount.get(shown) ?? 0;
      if (count >= 4) continue;
      offPageCount.set(shown, count + 1);
      const { id, key, title } = active.get(hidden)!;
      related.set(id, { id, key, title });
    }
    links.push(link);
  }
  return { links, related: [...related.values()] };
}
