import { randomUUID } from "node:crypto";
import type { HarnessRun, HarnessMessage } from "../../shared/harness/contracts.js";
import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";
import { memoryLanguageLabel } from "../../shared/project-memory/language.js";
import type { MemoryOrganizationEntry } from "../../shared/project-memory/organization.js";
import type { HarnessHistory, HarnessMetadata, HarnessMetadataTransaction } from "../harness/ports.js";
import { decode } from "../harness/records.js";
import type { RecordedMemoryTurn } from "./backfill.js";
import type { ModelReviewPort } from "./model-review.js";
import { modelExcerpt } from "./model-review.js";
import { entryId, namespace, type MemoryJob } from "./records.js";

export interface MemoryOrganizationBoundary {
  owner: string;
  projectId: string;
  conversationId: string;
  fromBytes: number;
  sourceRevision: number;
  policyRevision: number;
  generation: number;
}

interface MemoryOrganizationWork extends MemoryOrganizationBoundary {
  throughBytes: number;
  seq: number;
  attempts: number;
  lease?: string;
}

const pendingKind = "project-memory-organization";
const finishedKind = "memory-organization-cursor";
const failedKind = "memory-organization-failed";
const key = (id: string) => `memory-organization:${id}`;
export const memoryOrganizationLookbackMs = 30 * 86_400_000;
const leaseMs = 180_000;
const maxAttempts = 4;

export const sameOrganizationBoundary = (left: MemoryOrganizationBoundary, right: MemoryOrganizationBoundary) =>
  left.owner === right.owner &&
  left.projectId === right.projectId &&
  left.sourceRevision === right.sourceRevision &&
  left.policyRevision === right.policyRevision &&
  left.generation === right.generation;

type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type ScanScope = RuntimeSelection | null;
type ScanItem = { message: HarnessMessage; throughBytes: number };

export class MemoryOrganizations {
  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly now: () => number,
    private readonly scope: (work: MemoryOrganizationWork, reader: Reader) => Promise<ScanScope>,
    private readonly page: (
      work: MemoryOrganizationWork,
      selection: RuntimeSelection,
      signal: AbortSignal,
    ) => Promise<{ nextBytes: number; turns: RecordedMemoryTurn[] }>,
    private readonly record: (
      tx: HarnessMetadataTransaction,
      work: MemoryOrganizationWork,
      turns: RecordedMemoryTurn[],
    ) => Promise<number>,
  ) {}

  async enqueue(
    tx: HarnessMetadataTransaction,
    boundary: MemoryOrganizationBoundary,
    throughBytes: number,
    seq: number,
  ) {
    const id = key(boundary.conversationId),
      prior = await tx.get(id);
    const previous = decode<MemoryOrganizationWork>(prior);
    const same = previous && sameOrganizationBoundary(previous, boundary);
    if (same && previous.throughBytes >= throughBytes) return;
    const advance = same && prior?.kind === pendingKind;
    const work: MemoryOrganizationWork = {
      ...boundary,
      throughBytes,
      seq,
      attempts: advance ? previous.attempts : 0,
      ...(advance && previous.lease ? { lease: previous.lease } : {}),
      fromBytes: same ? previous.fromBytes : boundary.fromBytes,
    };
    await tx.put(
      {
        id,
        kind: pendingKind,
        owner: namespace(work.owner, work.projectId),
        revision: (prior?.revision ?? 0) + 1,
        data: JSON.stringify(work),
        updatedAt: work.lease ? prior!.updatedAt : this.now(),
      },
      prior?.revision ?? null,
    );
  }

  async status(
    tx: Reader,
    boundary: Pick<MemoryOrganizationBoundary, "conversationId"> & Partial<MemoryOrganizationBoundary>,
  ) {
    const row = await tx.get(key(boundary.conversationId));
    const work = decode<MemoryOrganizationWork>(row);
    if (
      !work ||
      work.generation !== boundary.generation ||
      work.sourceRevision !== boundary.sourceRevision ||
      work.policyRevision !== boundary.policyRevision
    )
      return { pending: 0, failed: 0 };
    return { pending: row?.kind === pendingKind ? 1 : 0, failed: row?.kind === failedKind ? 1 : 0 };
  }

  async retry(tx: HarnessMetadataTransaction, id: string) {
    const prior = await tx.get(key(id));
    if (!prior || prior.kind !== failedKind) return 0;
    const work = decode<MemoryOrganizationWork>(prior)!;
    if (!(await this.scope(work, tx))) return 0;
    await tx.put(
      {
        ...prior,
        kind: pendingKind,
        data: JSON.stringify({ ...work, attempts: 0, lease: undefined }),
        updatedAt: this.now(),
        revision: prior.revision + 1,
      },
      prior.revision,
    );
    return 1;
  }

  async processNext(signal: AbortSignal) {
    const [due] = await this.metadata.list(pendingKind, undefined, {
      limit: 1,
      oldestFirst: true,
      updatedThrough: this.now(),
    });
    if (!due || signal.aborted) return;
    const reader = { get: (id: string) => this.metadata.read(id), list: this.metadata.list.bind(this.metadata) };
    const work = await this.metadata.transaction(async (tx) => {
      const current = await tx.get(due.id);
      if (!current || current.kind !== pendingKind || current.updatedAt > this.now()) return null;
      const next = { ...current, revision: current.revision + 1 };
      const pending = decode<MemoryOrganizationWork>(current)!;
      if (pending.attempts >= maxAttempts) {
        await tx.put({ ...next, kind: failedKind }, current.revision);
        return null;
      }
      const claimed = { ...pending, attempts: pending.attempts + 1, lease: randomUUID() };
      await tx.put({ ...next, updatedAt: this.now() + leaseMs, data: JSON.stringify(claimed) }, current.revision);
      return claimed;
    });
    if (!work) return;
    const finish = async (page?: { nextBytes: number; turns: RecordedMemoryTurn[] }, failed = false) =>
      this.metadata.transaction(async (tx) => {
        const row = await tx.get(due.id);
        const current = decode<MemoryOrganizationWork>(row);
        if (!row || !current || current.lease !== work.lease || row.updatedAt <= this.now()) return;
        const next = { ...current };
        delete next.lease;
        let kind = pendingKind;
        let delay = 0;
        if (signal.aborted) {
          next.attempts--;
        } else if (failed) {
          if (work.attempts >= maxAttempts) kind = failedKind;
          else delay = 1000 * 2 ** work.attempts;
        } else if (!page || !(await this.scope(work, tx))) {
          kind = finishedKind;
        } else {
          await this.record(tx, work, page.turns);
          // Advance the cursor in the same transaction as the evidence. Later completions extend the high watermark.
          next.fromBytes = page.nextBytes;
          next.attempts = 0;
          if (next.fromBytes >= next.throughBytes) kind = finishedKind;
        }
        await tx.put(
          {
            ...row,
            kind,
            revision: row.revision + 1,
            data: JSON.stringify(next),
            updatedAt: this.now() + delay,
          },
          row.revision,
        );
      });
    try {
      const selection = await this.scope(work, reader);
      await finish(selection ? await this.page(work, selection, signal) : undefined);
    } catch {
      await finish(undefined, true);
    }
  }
}

export async function organizeHistoryPage(input: {
  owner: string;
  projectId: string;
  conversationId: string;
  throughBytes: number;
  policyRevision: number;
  generation: number;
  nextBytes: number;
  items: ScanItem[];
  selection: RuntimeSelection;
  history: HarnessHistory;
  reader: Reader;
  models?: ModelReviewPort;
  entries: () => Promise<MemoryOrganizationEntry[]>;
  preferences: () => Promise<{ language: string; revision: string }>;
  signal?: AbortSignal;
  eligible?: () => Promise<boolean>;
}): Promise<RecordedMemoryTurn[]> {
  const accepted = new Map<string, { run: HarnessRun; user: string; item: ScanItem }>();
  for (const item of input.items) {
    const { message } = item;
    const user = modelExcerpt(message.text);
    if (!user || message.runtimeId === "import" || !message.runId) continue;
    const run = decode<HarnessRun>(await input.reader.get(`run:${message.runId}`));
    if (
      run?.status !== "complete" ||
      run.owner !== input.owner ||
      run.conversationId !== input.conversationId ||
      run.userMessageId !== message.id
    )
      continue;
    accepted.set(message.id, { run, user, item });
  }
  if (!accepted.size) return [];
  if (!input.models?.organize) throw new Error("Memory organization is unavailable.");

  const assistantText = new Map([...accepted.values()].map(({ run }) => [run.assistantMessageId, ""]));
  // The assistant text is optional context. Evidence always points to a verified user message.
  const visible = await input.history.window(input.owner, input.conversationId, input.throughBytes, {
    beforeBytes: input.nextBytes,
    maxBytes: 1024 * 1024 + 1,
  });
  for (const event of visible.events) {
    if (event.type !== "text" || !assistantText.has(event.messageId)) continue;
    const previous = assistantText.get(event.messageId)!;
    if (previous.length < 16_385) assistantText.set(event.messageId, previous + event.text.slice(0, 16_385));
  }
  const [entries, preferences] = await Promise.all([input.entries(), input.preferences()]);
  const sources = [...accepted.entries()].map(([id, { run, user }]) => ({
    id,
    user,
    assistant: modelExcerpt(assistantText.get(run.assistantMessageId) ?? "") ?? undefined,
  }));
  const existing = entries.map((entry) => ({ ...entry, value: entry.value && modelExcerpt(entry.value) }));
  input.signal?.throwIfAborted();
  if (input.eligible && !(await input.eligible())) return [];
  const found = await input.models.organize(
    input.owner,
    input.selection,
    { sources, existing, language: { tag: preferences.language, name: memoryLanguageLabel(preferences.language) } },
    input.signal ?? AbortSignal.timeout(120_000),
  );
  return found.map(({ sourceId, expectedVersion, expectedRelations, ...claim }) => {
    const { message, throughBytes } = accepted.get(sourceId)!.item;
    const job: MemoryJob = {
      owner: input.owner,
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: sourceId,
      seq: message.seq,
      throughBytes,
      policyRevision: input.policyRevision,
      generation: input.generation,
      createdAt: message.createdAt,
      attempts: 0,
    };
    return {
      job,
      claims: [claim],
      expected: { id: entryId(claim.key, claim.scope), version: expectedVersion },
      expectedRelations,
      languageRevision: preferences.revision,
    };
  });
}
