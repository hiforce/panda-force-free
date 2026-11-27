import type { MemoryEntry, MemoryTerrain } from "../../shared/project-memory/contracts.js";
import type { HarnessMetadataTransaction } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { digest, type MemoryEvidence } from "./records.js";
import { memoryFocusPages } from "./focus-terrain.js";
import { memoryTerrainRelations } from "./relations.js";

type Place = Pick<MemoryEntry, "id" | "key">;
const kind = "project-memory-terrain";
const plateSize = 6;
const topicId = (key: string) => digest(["topic", key]);
const overviewId = digest(["overview"]);
const plateId = (topic: string, index: number) => digest(["plate", topic, index]);

async function terrainSlots(tx: HarnessMetadataTransaction, bucket: string, topic: string, ids: string[]) {
  const key = "memory-terrain:" + digest([bucket, topic]);
  const slots = decode<Record<string, number>>(await tx.get(key)) ?? {};
  let next = Object.keys(slots).length;
  const initial = next;
  for (const id of ids.sort()) {
    if (slots[id] === undefined) slots[id] = next++;
  }
  if (initial !== next) await save(tx, key, kind, bucket, slots);
  return slots;
}

export async function reserveMemoryPlaces(tx: HarnessMetadataTransaction, bucket: string, places: Iterable<Place>) {
  const topics = new Map<string, string[]>();
  const all: string[] = [];
  for (const { id, key } of places) {
    all.push(id);
    const topic = topicId(key);
    const ids = topics.get(topic);
    if (ids) ids.push(id);
    else topics.set(topic, [id]);
  }
  for (const [topic, ids] of topics) await terrainSlots(tx, bucket, topic, ids);
  if (all.length) await terrainSlots(tx, bucket, overviewId, all);
}

export async function readMemoryTerrain(
  tx: HarnessMetadataTransaction,
  bucket: string,
  entries: MemoryEntry[],
  groups: ReadonlyMap<string, MemoryEvidence[]>,
  selectedTopic?: string,
  selectedPlate?: string,
  options: { overview?: boolean; timeline?: boolean; focus?: 1 | 2; place?: string } = {},
): Promise<MemoryTerrain> {
  const byKey = new Map<string, string | undefined>();
  for (const { key, title } of entries) if (!byKey.get(key)) byKey.set(key, title);
  const topics = Array.from(byKey, ([name, title]) => ({ id: topicId(name), name, ...(title ? { title } : {}) }));
  const selected = options.place ? entries.find(({ id }) => id === options.place) : undefined;
  if (entries.length && options.focus) {
    const root = selected ?? entries[0]!;
    const pages = memoryFocusPages(root, entries, groups, options.focus);
    const plates = pages.map((_, index) => plateId(digest(["focus", root.id, options.focus]), index));
    const page = Math.max(0, plates.indexOf(selectedPlate ?? ""));
    const places = pages[page]!;
    return {
      topics,
      topic: null,
      plate: plates[page]!,
      plates,
      places,
      place: root.id,
      ...memoryTerrainRelations(places, entries, groups),
    };
  }
  if (entries.length && options.timeline) {
    const dates = entries.map((entry) => {
      const evidence = (groups.get(entry.id) ?? []).filter(
        ({ recordedAt }) => recordedAt > 0 && Number.isFinite(recordedAt),
      );
      const sources = evidence.filter(({ conversationId }) => !!conversationId);
      const first = (sources.length ? sources : evidence).reduce<number | null>(
        (at, { recordedAt }) => (at === null ? recordedAt : Math.min(at, recordedAt)),
        null,
      );
      return { entry, ...(first === null ? {} : { time: { at: first, source: sources.length > 0 } }) };
    });
    dates.sort((a, b) => (a.time?.at ?? Infinity) - (b.time?.at ?? Infinity) || a.entry.id.localeCompare(b.entry.id));
    const count = Math.ceil(dates.length / plateSize);
    const plates = Array.from({ length: count }, (_, index) => plateId("timeline", index));
    const index = selected ? dates.findIndex(({ entry }) => entry.id === selected.id) : -1;
    const page = index >= 0 ? Math.floor(index / plateSize) : Math.max(0, plates.indexOf(selectedPlate ?? ""));
    const places = dates.slice(page * plateSize, (page + 1) * plateSize).map((place, slot) => ({ ...place, slot }));
    return {
      topics,
      topic: null,
      plates,
      plate: plates[page]!,
      places,
      ...(selected ? { place: selected.id } : {}),
      ...memoryTerrainRelations(places, entries, groups),
    };
  }
  const topic =
    (topics.find(({ id }) => id === (selected ? topicId(selected.key) : selectedTopic)) ?? topics[0])?.id ?? null;
  const map = options.overview ? overviewId : topic;
  if (!map || !entries.length) return { topics, topic, plates: [], plate: null, places: [], links: [], related: [] };
  const visible = options.overview ? entries : entries.filter(({ key }) => topicId(key) === topic);
  // Existing projects acquire places on their first terrain visit. Only opaque IDs occupy persisted slots.
  const slots = await terrainSlots(
    tx,
    bucket,
    map,
    visible.map(({ id }) => id),
  );
  const ordered = visible.map((entry) => ({ entry, index: slots[entry.id]! })).sort((a, b) => a.index - b.index);
  // Compact the overview after a withdrawal so a sparse old page does not hide current landmarks.
  const indexed = options.overview ? ordered.map(({ entry }, index) => ({ entry, index })) : ordered;
  const pageOf = (index: number) => plateId(map, Math.floor(index / plateSize));
  const plates = Array.from(new Set(indexed.map(({ index }) => pageOf(index))));
  const linked =
    selected ??
    (options.overview && selectedTopic ? visible.find(({ key }) => topicId(key) === selectedTopic) : undefined);
  const index = linked ? indexed.find(({ entry }) => entry.id === linked.id)?.index : undefined;
  const plate = index !== undefined ? pageOf(index) : (plates.find((id) => id === selectedPlate) ?? plates[0] ?? null);
  const places = indexed.flatMap(({ index, entry }) =>
    pageOf(index) === plate ? [{ slot: index % plateSize, entry }] : [],
  );
  return {
    topics,
    topic: options.overview ? null : topic,
    plates,
    plate,
    places,
    ...memoryTerrainRelations(places, entries, groups),
    ...(linked ? { place: linked.id } : {}),
  };
}
