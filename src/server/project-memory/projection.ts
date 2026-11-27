import { isProjectMemoryScope, type MemoryEntry } from "../../shared/project-memory/contracts.js";
import type { MemoryEvidence, MemoryOrder } from "./records.js";
import { compareMemoryOrder, entryId, entryVersion } from "./records.js";
import { memoryKey } from "./rules.js";

export function groupMemoryEvidence(
  evidence: readonly MemoryEvidence[],
  replacements: ReadonlyMap<string, MemoryOrder>,
): Map<string, MemoryEvidence[]> {
  const groups = new Map<string, MemoryEvidence[]>();
  for (const row of evidence) {
    const id = entryId(row.key, row.scope);
    const replacement = replacements.get(id);
    if (replacement && row.recordedAt < replacement.recordedAt) continue;
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }

  return groups;
}

export function describeMemory(
  id: string,
  evidence: readonly MemoryEvidence[],
): MemoryEntry & { state: "active" | "conflict" } {
  const current = [...evidence].sort(compareMemoryOrder);
  const first = current[0]!;
  const title = current.findLast((row) => row.title)?.title;
  const conflict = current.some((row) => row.value !== first.value);
  const packages = [...new Set(current.flatMap((row) => (row.packageId ? [row.packageId] : [])))];
  return {
    id,
    key: first.key,
    ...(title ? { title } : {}),
    scope: first.scope,
    state: conflict ? "conflict" : "active",
    value: conflict ? null : first.value,
    version: conflict ? null : entryVersion(id, first.value),
    sources: current.flatMap(({ conversationId, messageId }) =>
      conversationId && messageId ? [{ conversationId, messageId }] : [],
    ),
    ...(packages.length ? { packages } : {}),
    ...(current.some(({ legacy }) => legacy)
      ? { manual: current.filter(({ legacy }) => legacy).map(({ id }) => id) }
      : {}),
  };
}

export function projectMemories(groups: ReadonlyMap<string, MemoryEvidence[]>): MemoryEntry[] {
  return Array.from(groups, ([id, group]) => describeMemory(id, group)).sort(
    (left, right) => left.key.localeCompare(right.key) || left.scope.localeCompare(right.scope),
  );
}

export function projectMemoryMatcher(prompt: string) {
  const query = memoryKey(prompt.replace(/[^\p{L}\p{N}_.-]+/gu, " "));
  if (!query) return null;
  const bounded = `-${query}-`;
  return (value: string) =>
    /[\u0080-\u{10FFFF}]/u.test(value) ? query.includes(value) : bounded.includes(`-${value}-`);
}

export function matchesMemoryEntry(entry: Pick<MemoryEntry, "key" | "title">, matches: (value: string) => boolean) {
  return matches(entry.key) || (!!entry.title && matches(memoryKey(entry.title.replace(/[^\p{L}\p{N}_.-]+/gu, " "))));
}

export function matchingMemories(
  entries: readonly MemoryEntry[],
  matches: (value: string) => boolean,
  conversationId: string,
  indexed?: (entry: MemoryEntry) => boolean,
  personal?: (entry: MemoryEntry) => number,
  existing: readonly Pick<MemoryEntry, "id" | "version">[] = [],
) {
  const exact = entries.filter((entry) => matchesMemoryEntry(entry, matches));
  const projectScope = (entry: MemoryEntry) =>
    entry.scope === "project" || (!entry.team && isProjectMemoryScope(entry.scope));
  const scopes = new Set(
    exact.filter((entry) => !projectScope(entry) && matches(entry.scope)).map((entry) => entry.key),
  );
  const defaults = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.team || !projectScope(entry)) continue;
    const value = defaults.get(entry.key);
    defaults.set(entry.key, value === undefined || value === entry.value ? entry.value : null);
  }
  const available = new Map(existing.map(({ id, version }) => [id, version]));
  const eligible = (entry: MemoryEntry) =>
    entry.state === "active" &&
    available.get(entry.id) !== entry.version &&
    (!projectScope(entry) || entry.team || defaults.get(entry.key) !== null) &&
    (entry.team ||
      entry.packages?.length ||
      entry.manual?.length ||
      entry.sources.some((source) => source.conversationId !== conversationId));
  const authored = entries
    .flatMap((entry) => {
      if (!personal || entry.team || !eligible(entry)) return [];
      const rank = personal(entry);
      return rank < 0 ? [] : [{ entry, rank }];
    })
    .sort((a, b) => a.rank - b.rank);
  const chosen = new Set<number>();
  const primary = authored.filter(({ rank }) => {
    if (chosen.has(rank)) return false;
    chosen.add(rank);
    return true;
  });
  const candidates = new Map<string, MemoryEntry>();
  function include(entry: MemoryEntry) {
    const identity = entryId(entry.key, projectScope(entry) ? "project" : entry.scope);
    if (!candidates.has(identity)) candidates.set(identity, entry);
  }
  for (const { entry } of primary) include(entry);
  for (const entry of exact) {
    if (
      eligible(entry) &&
      (!indexed || indexed(entry)) &&
      (scopes.has(entry.key) ? !projectScope(entry) && matches(entry.scope) : projectScope(entry))
    )
      include(entry);
  }
  for (const { entry } of authored) include(entry);
  return [...candidates.values()].slice(0, personal ? 5 : 4).map((entry) => ({
    ...entry,
    sources: entry.sources.filter((source) => source.conversationId !== conversationId).slice(0, 2),
    ...(entry.packages ? { packages: entry.packages.slice(0, 2) } : {}),
    ...(entry.manual ? { manual: entry.manual.slice(0, 2) } : {}),
  }));
}

/** A recipient's distinct scopes must agree before either one enters that conversation. */
export function compatibleProjectMemory(personal: MemoryEntry[], team: MemoryEntry[]) {
  if (!team.length) return personal;
  const own = new Map(personal.map((entry) => [entry.id, entry]));
  const conflicts = new Set<string>();
  for (const item of team) {
    const id = entryId(item.key, item.scope);
    const privateEntry = own.get(id);
    if (
      privateEntry &&
      (privateEntry.state !== "active" || item.state !== "active" || privateEntry.value !== item.value)
    )
      conflicts.add(id);
  }
  return [...personal, ...team].map((entry): MemoryEntry =>
    conflicts.has(entryId(entry.key, entry.scope))
      ? { ...entry, state: "conflict", value: null, version: null, sources: [] }
      : entry,
  );
}
