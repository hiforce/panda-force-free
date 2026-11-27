import type {
  MemoryDetail,
  MemoryEntry,
  MemoryTransition,
  MemoryVersion,
} from "../../shared/project-memory/contracts.js";
import type { HarnessMetadataTransaction } from "../harness/ports.js";
import { decode } from "../harness/records.js";
import { projectMergedMemory } from "./conflict-worker.js";
import { describeMemory } from "./projection.js";
import { digest, type MemoryEvidence } from "./records.js";

const kind = "project-memory-version";
const track = (bucket: string, id: string) => `${bucket}:${id}`;
const versionKey = (owner: string, revision: number) => `memory-version:${owner}:${revision}`;

interface VersionRecord {
  revision: number;
  changedAt: number;
  reason: MemoryTransition;
  state: Exclude<MemoryEntry["state"], "withdrawn"> | null;
  evidenceIds: string[];
  mergedValue?: string;
  title?: string;
}

function transition(
  mode: "learn" | "withdraw",
  previous: VersionRecord | null,
  state: VersionRecord["state"],
  replacing: boolean,
): MemoryTransition {
  if (mode === "withdraw") {
    if (!state) return "withdrawn";
    if (previous?.state === "conflict" && state === "active") return "recovered";
    return state === "conflict" && previous?.state !== "conflict" ? "conflict" : "sourceWithdrawn";
  }
  if (state === "conflict") return "conflict";
  if (!previous) return "recorded";
  if (replacing) return "replaced";
  if (previous.state !== "active") return "recovered";
  return "corroborated";
}

export async function appendMemoryVersions(
  tx: HarnessMetadataTransaction,
  bucket: string,
  ids: readonly string[],
  groups: ReadonlyMap<string, MemoryEvidence[]>,
  changedAt: number,
  mode: "learn" | "withdraw",
  replaced: ReadonlySet<string> = new Set(),
) {
  for (const id of ids) {
    const owner = track(bucket, id);
    const [latest] = await tx.list(kind, owner, { limit: 1 });
    const previous = decode<VersionRecord>(latest ?? null);
    const evidence = groups.get(id) ?? [];
    const entry = evidence.length ? describeMemory(id, evidence) : null;
    const state = entry?.state ?? null;
    if (!previous && !state) continue;
    const evidenceIds = evidence.map((row) => row.id).sort();
    const mergedValue = evidence[0]?.projectedFrom === undefined ? undefined : evidence[0].value;
    if (
      previous?.state === state &&
      previous.title === entry?.title &&
      previous.mergedValue === mergedValue &&
      digest(previous.evidenceIds) === digest(evidenceIds)
    )
      continue;
    const revision = (previous?.revision ?? 0) + 1;
    const event: VersionRecord = {
      revision,
      changedAt,
      reason: transition(mode, previous, state, replaced.has(id)),
      state,
      evidenceIds,
      mergedValue,
      title: entry?.title,
    };
    // The track's indexed timestamp is the monotonic revision used by history cursors.
    await tx.put(
      { id: versionKey(owner, revision), kind, owner, revision: 1, data: JSON.stringify(event), updatedAt: revision },
      null,
    );
  }
}

export async function readMemoryDetail(
  tx: HarnessMetadataTransaction,
  bucket: string,
  id: string,
  current: MemoryEvidence[],
  visible: ReadonlyMap<string, MemoryEvidence>,
  before?: number,
): Promise<MemoryDetail> {
  const rows = await tx.list(kind, track(bucket, id), {
    limit: 21,
    updatedThrough: before === undefined ? undefined : before - 1,
  });
  const events = rows.slice(0, 20).map((row) => decode<VersionRecord>(row)!);
  const versions: MemoryVersion[] = [];
  for (const record of events) {
    const { revision, changedAt, reason, state, evidenceIds, mergedValue, title } = record;
    if (!state) {
      versions.push({ revision, changedAt, reason, entry: null });
      continue;
    }
    const evidence = evidenceIds.flatMap((key) => {
      const source = visible.get(key);
      return source ? [source] : [];
    });
    // A merged entry and a disagreement both rely on all the evidence recorded for that version.
    if (!evidence.length || ((mergedValue || state === "conflict") && evidence.length !== evidenceIds.length)) continue;
    const entry = describeMemory(id, mergedValue ? projectMergedMemory(evidence, mergedValue, title) : evidence);
    if (title) entry.title = title;
    if (entry.state === state) versions.push({ revision, changedAt, reason, entry });
  }
  const next = rows.length > 20 ? events.at(-1)!.revision : null;
  return { current: current.length ? describeMemory(id, current) : null, versions, next };
}
