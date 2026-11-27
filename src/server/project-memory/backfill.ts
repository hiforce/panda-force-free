import { HarnessError, type HarnessMessage } from "../../shared/harness/contracts.js";
import type { MemoryBackfillTask, MemoryBackfillView } from "../../shared/project-memory/contracts.js";
import type { HarnessHistory, HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode } from "../harness/records.js";
import type { ProjectSessionCheckpoint } from "../projects/session-membership.js";
import type { MemoryJob, PausedMemoryRange } from "./records.js";
import type { MemoryClaim } from "./rules.js";
import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";

type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type Destination = { id: string; owner: string; projectId: string };
type Available = {
  availability: "available";
  selection: RuntimeSelection;
  lower: ProjectSessionCheckpoint;
  throughBytes: number;
  activeRunId?: string | null;
  generation: number;
  sourceRevision: number;
  policyRevision: number;
  pausedRanges: readonly PausedMemoryRange[];
};
type Scope = Available | { availability: Exclude<MemoryBackfillView["availability"], "available"> };
type Work = Destination & {
  requestId: string;
  from: number;
  to: number;
  lower: ProjectSessionCheckpoint;
  throughBytes: number;
  nextBytes: number;
  activeRunId?: string | null;
  generation: number;
  sourceRevision: number;
  policyRevision: number;
  added: number;
  updatedAt: number;
  attempts: number;
  state: MemoryBackfillTask["state"];
};
type BackfillRequest = { from?: unknown; to?: unknown; days?: 7 | 30; requestId: unknown };
export type RecordedMemoryTurn = {
  job: MemoryJob;
  claims: MemoryClaim[];
  expected?: { id: string; version: string | null };
  expectedRelations?: Array<{ id: string; version: string }>;
  languageRevision?: string;
};

const pendingKind = "project-memory-backfill";
const receiptKind = "project-memory-backfill-receipt";
const key = (id: string) => `memory-backfill:${id}`;
const leaseMs = 180_000;
const maxAttempts = 6;
const batchPages = 8;
const batchBudgetMs = 150;
const batchPauseMs = 50;
const day = 86400000;

function stateOf(work: Work): MemoryBackfillTask {
  const total = work.throughBytes - work.lower.throughBytes;
  return {
    from: work.from,
    to: work.to,
    state: work.state,
    progress: total === 0 ? 100 : Math.floor(((work.nextBytes - work.lower.throughBytes) * 100) / total),
    added: work.added,
    updatedAt: work.updatedAt,
  };
}

function current(work: Work, scope: Scope): boolean {
  return (
    scope.availability === "available" &&
    work.generation === scope.generation &&
    work.sourceRevision === scope.sourceRevision &&
    work.policyRevision === scope.policyRevision &&
    work.lower.throughBytes === scope.lower.throughBytes &&
    work.lower.throughSeq === scope.lower.throughSeq &&
    work.throughBytes <= scope.throughBytes
  );
}

async function persist(tx: HarnessMetadataTransaction, work: Work, before: HarnessRecord | null, due: number) {
  const row: HarnessRecord = {
    id: key(work.id),
    kind: work.state === "queued" || work.state === "running" ? pendingKind : receiptKind,
    owner: work.owner,
    revision: (before?.revision ?? 0) + 1,
    data: JSON.stringify(work),
    updatedAt: due,
  };
  await tx.put(row, before?.revision ?? null);
  return row;
}

export class MemoryBackfills {
  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly history: HarnessHistory,
    private readonly now: () => number,
    private readonly scope: (destination: Destination, reader: Reader) => Promise<Scope>,
    private readonly record: (
      tx: HarnessMetadataTransaction,
      destination: Destination,
      turns: readonly RecordedMemoryTurn[],
    ) => Promise<number>,
    private readonly organize: (input: {
      owner: string;
      projectId: string;
      conversationId: string;
      throughBytes: number;
      nextBytes: number;
      generation: number;
      policyRevision: number;
      items: Array<{ message: HarnessMessage; throughBytes: number }>;
      selection: RuntimeSelection;
      signal?: AbortSignal;
      eligible: () => Promise<boolean>;
    }) => Promise<RecordedMemoryTurn[]>,
  ) {}

  view(destination: Destination): Promise<MemoryBackfillView> {
    return this.metadata.transaction(async (tx) => {
      const scope = await this.scope(destination, tx);
      const work = decode<Work>(await tx.get(key(destination.id)));
      return {
        availability: scope.availability,
        task: work?.owner === destination.owner && work.projectId === destination.projectId ? stateOf(work) : null,
      };
    });
  }

  async start(destination: Destination, request: BackfillRequest): Promise<MemoryBackfillTask> {
    const { requestId, days } = request;
    const now = this.now();
    const from = days ? now - days * day : request.from;
    const to = days ? now : request.to;
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to <= from ||
      from > now ||
      to > now + 2 * day ||
      to - from > 30 * day ||
      from < now - 30 * day - 60_000 ||
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(requestId)
    )
      throw new HarnessError("invalidInput");
    return this.metadata.transaction(async (tx) => {
      const scope = await this.scope(destination, tx);
      if (scope.availability === "forbidden") throw new HarnessError("forbidden", 403);
      if (scope.availability !== "available") throw new HarnessError("conflict", 409);
      const row = await tx.get(key(destination.id));
      const prior = decode<Work>(row);
      if (prior && (prior.owner !== destination.owner || prior.projectId !== destination.projectId))
        throw new HarnessError("notFound", 404);
      if (prior?.requestId === requestId) {
        if (days ? prior.to - prior.from !== days * day : prior.from !== from || prior.to !== to)
          throw new HarnessError("conflict", 409);
        return stateOf(prior);
      }
      if (prior && current(prior, scope)) {
        const sameRange = prior.from === from && prior.to === to;
        if (row?.kind === pendingKind) {
          if (sameRange) return stateOf(prior);
          throw new HarnessError("busy", 409);
        }
        if (sameRange && prior.state === "complete" && prior.throughBytes === scope.throughBytes) return stateOf(prior);
        if (sameRange && prior.state === "failed") {
          const next = { ...prior, requestId, state: "queued", attempts: 0, updatedAt: now } as const;
          await persist(tx, next, row, now);
          return stateOf(next);
        }
      }
      const work: Work = {
        ...destination,
        requestId,
        from,
        to,
        lower: scope.lower,
        throughBytes: scope.throughBytes,
        nextBytes: scope.lower.throughBytes,
        activeRunId: scope.activeRunId,
        generation: scope.generation,
        sourceRevision: scope.sourceRevision,
        policyRevision: scope.policyRevision,
        added: 0,
        attempts: 0,
        updatedAt: now,
        state: scope.throughBytes === scope.lower.throughBytes ? "complete" : "queued",
      };
      await persist(tx, work, row, now);
      return stateOf(work);
    });
  }

  async processReady(signal: AbortSignal) {
    let deadline = performance.now() + batchBudgetMs;
    let pages = 0;
    while (!signal.aborted && (await this.processNext(signal))) {
      if (signal.aborted) break;
      pages++;
      // Allow waiting requests through between pages and leave a longer pause between batches.
      if (pages >= batchPages || performance.now() >= deadline) {
        await Bun.sleep(batchPauseMs);
        deadline = performance.now() + batchBudgetMs;
        pages = 0;
      } else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async processNext(signal?: AbortSignal): Promise<boolean> {
    const now = this.now();
    const [due] = await this.metadata.list(pendingKind, undefined, {
      limit: 1,
      oldestFirst: true,
      updatedThrough: now,
    });
    if (!due) return false;
    const lease = await this.metadata.transaction(async (tx) => {
      const row = await tx.get(due.id);
      if (row?.revision !== due.revision || row.updatedAt > now) return null;
      const work = decode<Work>(row)!;
      if (work.attempts >= maxAttempts) {
        await persist(tx, { ...work, state: "failed", updatedAt: now }, row, now);
        return null;
      }
      return persist(
        tx,
        { ...work, attempts: work.attempts + 1, state: "running", updatedAt: now },
        row,
        now + leaseMs,
      );
    });
    if (!lease) return true;
    const work = decode<Work>(lease)!;
    try {
      const reader: Reader = {
        get: (id) => this.metadata.read(id),
        list: (kind, owner, page) => this.metadata.list(kind, owner, page),
      };
      const scope = await this.scope(work, reader);
      const page =
        scope.availability === "available" && current(work, scope)
          ? await this.history.scanUserMessages(work.owner, work.id, work.throughBytes, work.nextBytes)
          : null;
      const turns =
        page && scope.availability === "available"
          ? await this.organize({
              ...work,
              conversationId: work.id,
              nextBytes: page.nextBytes,
              selection: scope.selection,
              signal,
              eligible: async () => current(work, await this.scope(work, reader)),
              items: page.messages.filter(
                ({ message }) =>
                  message.seq > work.lower.throughSeq &&
                  !scope.pausedRanges.some(
                    ({ afterSeq, throughSeq }) => message.seq > afterSeq && message.seq <= throughSeq,
                  ) &&
                  message.runId !== work.activeRunId &&
                  Number.isSafeInteger(message.createdAt) &&
                  message.createdAt >= work.from &&
                  message.createdAt < work.to,
              ),
            })
          : [];
      await this.metadata.transaction(async (tx) => {
        const row = await tx.get(lease.id);
        const now = this.now();
        if (row?.revision !== lease.revision || row.updatedAt <= now) return;
        if (signal?.aborted) {
          await persist(tx, { ...work, state: "queued", attempts: work.attempts - 1, updatedAt: now }, row, now);
          return;
        }
        if (!page || !current(work, await this.scope(work, tx))) {
          await persist(tx, { ...work, state: "stopped", updatedAt: now }, row, now);
          return;
        }
        const added = await this.record(tx, work, turns);
        const next: Work = {
          ...work,
          added: work.added + added,
          nextBytes: page.nextBytes,
          updatedAt: now,
          attempts: 0,
          state: page.nextBytes >= work.throughBytes ? "complete" : "queued",
        };
        await persist(tx, next, row, now);
      });
    } catch {
      await this.metadata.transaction(async (tx) => {
        const row = await tx.get(lease.id);
        const now = this.now();
        if (row?.revision !== lease.revision || row.updatedAt <= now) return;
        if (signal?.aborted) {
          await persist(tx, { ...work, state: "queued", attempts: work.attempts - 1, updatedAt: now }, row, now);
          return;
        }
        const state = work.attempts >= maxAttempts ? "failed" : "queued";
        await persist(
          tx,
          { ...work, state, updatedAt: now },
          row,
          state === "queued" ? now + 1000 * 2 ** work.attempts : now,
        );
      });
    }
    return true;
  }
}
