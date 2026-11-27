import { randomUUID } from "node:crypto";
import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";
import type { HarnessMetadata, HarnessMetadataTransaction } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { digest, namespace, type MemoryEvidence } from "./records.js";
import { memoryControlPattern, memoryCredentialPattern, verifiedMemoryTitle } from "./rules.js";

export const pendingConflictKind = "memory-conflict-pending";
export const resolvedConflictKind = "memory-conflict-resolved";
export const memoryResolutionKey = (bucket: string, entry: string) => `memory-resolution:${bucket}:${entry}`;
const workKey = (bucket: string, entry: string) => `memory-reconcile:${bucket}:${entry}`;
const leaseMs = 180_000;
const retryDelays = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
const batchSize = 12;

export type MemoryConflictDestination = { owner: string; projectId: string; entry: string };
export type MemoryResolution = {
  signature: string;
  value: string | null;
  title?: string;
  covered: string[];
  support: string[];
  recordedAt: number;
};
type ConflictWork = MemoryConflictDestination & { signature: string; attempts: number; lease?: string };
type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type ConflictSnapshot = {
  group: MemoryEvidence[];
  revision: string;
  selection: RuntimeSelection | null;
  language: MemoryConflictContext["language"];
};
export type MemoryConflictVariant = {
  id: string;
  value: string;
  recordedAt: number;
  evidence?: string;
  summary?: true;
};
export type MemoryConflictContext = {
  key: string;
  scope: string;
  language: { tag: string; name: string };
  variants: readonly MemoryConflictVariant[];
};
export type MemoryConflictDecision =
  | { selected: string; title?: string; value?: string }
  | { merged: string; sources: string[]; title?: string }
  | { discard: true }
  | null;
type Candidate = MemoryConflictVariant & { support: string[]; source?: MemoryEvidence };

const variantId = (value: string) => digest(value);
const signatureFor = (variants: readonly string[]) => digest([...variants].sort());

export function conflictSignature(group: readonly MemoryEvidence[]) {
  const variants = [...new Set(group.map(({ value }) => variantId(value)))];
  return variants.length > 1 ? signatureFor(variants) : null;
}

export function projectMergedMemory(group: readonly MemoryEvidence[], value: string, title?: string) {
  return group.map((row) => ({ ...row, value, ...(title ? { title } : {}), projectedFrom: row.value }));
}

export function applyMemoryResolutions(
  groups: Map<string, MemoryEvidence[]>,
  resolutions: ReadonlyMap<string, MemoryResolution>,
) {
  const dismissed = new Set<string>();
  for (const [entry, resolution] of resolutions) {
    const group = groups.get(entry);
    if (!group || conflictSignature(group) !== resolution.signature) continue;
    if (resolution.value === null) {
      groups.delete(entry);
      dismissed.add(entry);
      continue;
    }
    const supported = group.filter(({ value }) => resolution.support.includes(variantId(value)));
    if (!supported.length) continue;
    const value = resolution.value;
    groups.set(
      entry,
      resolution.support.length > 1 || supported.some((row) => row.value !== value)
        ? projectMergedMemory(supported, value, resolution.title)
        : supported.map((row) => (resolution.title ? { ...row, title: resolution.title } : row)),
    );
  }
  return { groups, dismissed };
}

function planResolution(group: MemoryEvidence[], previous: MemoryResolution | null) {
  const distinct = new Map<string, MemoryEvidence>();
  for (const row of group) {
    const hash = variantId(row.value);
    if (row.recordedAt >= (distinct.get(hash)?.recordedAt ?? -1)) distinct.set(hash, row);
  }
  const prior = previous?.covered.every((hash) => distinct.has(hash)) ? previous : null;
  const covered = [...(prior?.covered ?? [])];
  const candidates: Candidate[] = prior?.value
    ? [{ id: "previous", value: prior.value, recordedAt: prior.recordedAt, summary: true, support: prior.support }]
    : [];
  const next = [...distinct]
    .filter(([hash]) => !covered.includes(hash))
    .sort((a, b) => a[1].recordedAt - b[1].recordedAt);
  for (const [hash, source] of next.slice(0, batchSize)) {
    covered.push(hash);
    candidates.push({ id: source.id, value: source.value, recordedAt: source.recordedAt, support: [hash], source });
  }
  return { covered, candidates };
}

function resolveDecision(
  { candidates, covered }: ReturnType<typeof planResolution>,
  decision: NonNullable<MemoryConflictDecision>,
): MemoryResolution | null {
  const base = {
    covered,
    signature: signatureFor(covered),
    recordedAt: Math.max(...candidates.map(({ recordedAt }) => recordedAt)),
  };
  if ("discard" in decision) return { ...base, value: null, support: [] };
  const title = verifiedMemoryTitle(decision.title);
  const validValue = (value: string) =>
    !!value && value.length <= 240 && !memoryControlPattern.test(value) && !memoryCredentialPattern.test(value);
  if ("selected" in decision) {
    const selected = candidates.find(({ id }) => id === decision.selected);
    if (!selected) return null;
    const value = decision.value?.trim() ?? selected.value;
    return validValue(value) ? { ...base, value, title, support: selected.support } : null;
  }
  const sources = new Set(decision.sources);
  const value = decision.merged.trim();
  if (
    candidates.length < 2 ||
    sources.size !== candidates.length ||
    !candidates.every(({ id }) => sources.has(id)) ||
    !validValue(value)
  )
    return null;
  return { ...base, value, title, support: [...new Set(candidates.flatMap(({ support }) => support))] };
}

export class MemoryConflicts {
  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly now: () => number,
    private readonly snapshot: (work: MemoryConflictDestination, reader: Reader) => Promise<ConflictSnapshot | null>,
    private readonly decide: (
      work: MemoryConflictDestination,
      selection: RuntimeSelection,
      context: MemoryConflictContext,
      signal: AbortSignal,
    ) => Promise<MemoryConflictDecision>,
    private readonly excerpt: (work: MemoryConflictDestination, row: MemoryEvidence) => Promise<string | undefined>,
    private readonly onResolved: (tx: HarnessMetadataTransaction, work: MemoryConflictDestination) => Promise<void>,
  ) {}

  async detect(tx: HarnessMetadataTransaction, work: MemoryConflictDestination, group: MemoryEvidence[]) {
    const signature = conflictSignature(group);
    if (!signature) return;
    const bucket = namespace(work.owner, work.projectId);
    const id = workKey(bucket, work.entry);
    const prior = await tx.get(id);
    if (decode<ConflictWork>(prior)?.signature === signature) return;
    await tx.put(
      {
        id,
        kind: pendingConflictKind,
        owner: bucket,
        revision: (prior?.revision ?? 0) + 1,
        data: JSON.stringify({ ...work, signature, attempts: 0 }),
        updatedAt: this.now(),
      },
      prior?.revision ?? null,
    );
  }

  async process(signal: AbortSignal) {
    if (signal.aborted) return;
    const [due] = await this.metadata.list(pendingConflictKind, undefined, {
      oldestFirst: true,
      updatedThrough: this.now(),
      limit: 1,
    });
    if (!due) return;
    const work = await this.metadata.transaction(async (tx) => {
      const row = await tx.get(due.id);
      if (row?.kind !== pendingConflictKind || row.updatedAt > this.now()) return null;
      const next = { ...decode<ConflictWork>(row)!, lease: randomUUID() };
      await tx.put(
        { ...row, revision: row.revision + 1, data: JSON.stringify(next), updatedAt: this.now() + leaseMs },
        row.revision,
      );
      return next;
    });
    if (!work) return;

    const bucket = namespace(work.owner, work.projectId);
    const resultId = memoryResolutionKey(bucket, work.entry);
    const reader = { get: (id: string) => this.metadata.read(id), list: this.metadata.list.bind(this.metadata) };
    const observed = await this.snapshot(work, reader).catch(() => null);
    const relevant = observed && conflictSignature(observed.group) === work.signature;
    const result =
      relevant && observed.selection && !signal.aborted
        ? await this.reconcile(work, observed.group, observed.selection, observed.language, resultId, signal).catch(
            () => null,
          )
        : null;
    await this.metadata.transaction(async (tx) => {
      const row = await tx.get(due.id),
        current = decode<ConflictWork>(row);
      if (!row || current?.lease !== work.lease || row.updatedAt <= this.now()) return;
      const snapshot =
        (result || (observed && !relevant)) && !signal.aborted ? await this.snapshot(work, tx).catch(() => null) : null;
      if (snapshot && conflictSignature(snapshot.group) !== work.signature) {
        await tx.remove(row.id, row.revision);
        return;
      }
      let delay = 0;
      delete current.lease;
      if (snapshot?.selection && snapshot.revision === observed?.revision && result) {
        await save(tx, resultId, resolvedConflictKind, bucket, { entry: work.entry, ...result });
        if (result.signature === work.signature) {
          await this.onResolved(tx, work);
          await tx.remove(row.id, row.revision);
          return;
        }
        current.attempts = 0;
      } else if (!signal.aborted) {
        current.attempts = Math.min(current.attempts + 1, retryDelays.length);
        delay = retryDelays[current.attempts - 1]!;
      }
      await tx.put(
        { ...row, revision: row.revision + 1, data: JSON.stringify(current), updatedAt: this.now() + delay },
        row.revision,
      );
    });
  }

  private async reconcile(
    work: MemoryConflictDestination,
    group: MemoryEvidence[],
    selection: RuntimeSelection,
    language: MemoryConflictContext["language"],
    resultId: string,
    signal: AbortSignal,
  ) {
    const prior = decode<MemoryResolution>(await this.metadata.read(resultId));
    const plan = planResolution(group, prior);
    const variants = await Promise.all(
      plan.candidates.map(async ({ source, support: _support, ...variant }) => {
        const evidence = source ? await this.excerpt(work, source) : undefined;
        return { ...variant, ...(evidence ? { evidence } : {}) };
      }),
    );
    const { key, scope } = group[0]!;
    const decision = await this.decide(work, selection, { key, scope, language, variants }, signal);
    return decision ? resolveDecision(plan, decision) : null;
  }
}
