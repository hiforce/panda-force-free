import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";
import type { MemoryModelReview } from "../../shared/project-memory/contracts.js";
import type { HarnessHistory, HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode } from "../harness/records.js";
import { digest, modelJobKind, type MemoryConversation, type MemoryJob } from "./records.js";
import { modelDeadlineMs, modelExcerpt, type ModelReviewPort } from "./model-review.js";

export const modelReviewKind = "project-memory-model-review";
const budgetKind = "project-memory-model-budget";
const slotKind = "project-memory-model-slot";
const dayMs = 86_400_000;
const reviewRetentionMs = 7 * dayMs;
const dailyCalls = 32;
const dailyTokenBudget = 120_000;
type Budget = { calls: number; tokens: number };
type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type ReviewResult = Awaited<ReturnType<ModelReviewPort["review"]>>;
type Ports = {
  metadata: HarnessMetadata;
  history: HarnessHistory;
  models: ModelReviewPort;
  now(): number;
  reader: Reader;
  claim(row: HarnessRecord): Promise<HarnessRecord | null>;
  authorize(
    job: MemoryJob,
    reader: Reader,
  ): Promise<{ conversation: MemoryConversation; selection: RuntimeSelection } | null>;
};

async function expire(metadata: HarnessMetadata, now: number) {
  for (const kind of [modelReviewKind, budgetKind, slotKind]) {
    const expired = await metadata.list(kind, undefined, { limit: 16, oldestFirst: true, updatedThrough: now });
    if (!expired.length) continue;
    await metadata.transaction(async (tx) => {
      for (const row of expired) {
        const latest = await tx.get(row.id);
        if (latest?.revision === row.revision && latest.updatedAt <= now) await tx.remove(row.id, row.revision);
      }
    });
  }
}

async function excerpt(history: HarnessHistory, job: MemoryJob, conversation: MemoryConversation) {
  const page = await history.window(job.owner, job.conversationId, conversation.historyBytes, {
    beforeBytes: job.throughBytes,
    maxBytes: 1024 * 1024 + 1,
  });
  const event = page.events.find((item) => item.type === "message" && item.seq === job.seq);
  return event?.type === "message" &&
    event.message.id === job.messageId &&
    event.message.role === "user" &&
    event.message.attachments.length === 0 &&
    event.message.runtimeId !== "import"
    ? modelExcerpt(event.message.text)
    : null;
}

/** Claim and charge once before dispatch. Expired dispatches are reported without another paid call. */
export async function processModelReview(ports: Ports) {
  const { metadata, models, now, reader, claim, authorize, history } = ports;
  const startedAt = now();
  await expire(metadata, startedAt);
  const [waiting] = await metadata.list(modelJobKind, undefined, {
    limit: 1,
    oldestFirst: true,
    updatedThrough: startedAt,
  });
  if (!waiting) return;
  const row = await claim(waiting);
  if (!row) return;
  const job = decode<MemoryJob>(row)!;
  const project = digest(job.projectId);
  const slotId = "memory-model-slot:" + project;
  const dayEnd = (Math.floor(startedAt / dayMs) + 1) * dayMs;
  const budgetId = "memory-model-budget:" + digest([project, dayEnd]);
  let active = row;
  let reservedTokens = 0;
  let result: ReviewResult | null = null;
  const unavailable: ReviewResult = { status: "unavailable", candidates: [], tokens: null };

  try {
    const input = await authorize(job, reader);
    if (input && job.modelStarted) result = unavailable;
    const text = input && !job.modelStarted ? await excerpt(history, job, input.conversation) : null;
    if (input && text) {
      // Conservative on missing provider usage. Reported usage above the reservation is charged as well.
      const reservation = Buffer.byteLength(JSON.stringify(text)) + 5120;
      const ready = await metadata.transaction(async (tx) => {
        if ((await tx.get(row.id))?.revision !== row.revision || row.updatedAt <= now() || !(await authorize(job, tx)))
          return "defer";
        const slot = await tx.get(slotId);
        if (slot && slot.updatedAt > now()) {
          await tx.put(
            { ...row, revision: row.revision + 1, data: waiting.data, updatedAt: slot.updatedAt },
            row.revision,
          );
          return "defer";
        }
        const prior = await tx.get(budgetId);
        const quota = decode<Budget>(prior) ?? { calls: 0, tokens: 0 };
        if (quota.calls >= dailyCalls || quota.tokens + reservation > dailyTokenBudget) return "budget";
        const dispatched = { ...row, revision: row.revision + 1, data: JSON.stringify({ ...job, modelStarted: true }) };
        await tx.put(dispatched, row.revision);
        await tx.put(
          {
            id: budgetId,
            kind: budgetKind,
            owner: project,
            revision: (prior?.revision ?? 0) + 1,
            updatedAt: dayEnd + dayMs,
            data: JSON.stringify({ calls: quota.calls + 1, tokens: quota.tokens + reservation }),
          },
          prior?.revision ?? null,
        );
        await tx.put(
          {
            id: slotId,
            kind: slotKind,
            owner: project,
            revision: (slot?.revision ?? 0) + 1,
            updatedAt: dispatched.updatedAt,
            data: JSON.stringify({ id: dispatched.id, revision: dispatched.revision }),
          },
          slot?.revision ?? null,
        );
        return dispatched;
      });
      if (ready === "defer") return;
      if (ready === "budget") result = { status: "budget", candidates: [], tokens: null };
      else {
        active = ready;
        reservedTokens = reservation;
        if (await authorize(job, reader))
          result = await models.review(job.owner, input.selection, text, AbortSignal.timeout(modelDeadlineMs));
      }
    }
  } catch {
    result = unavailable;
  }

  await metadata.transaction(async (tx) => {
    if ((await tx.get(active.id))?.revision !== active.revision || active.updatedAt <= now()) return;
    const slot = await tx.get(slotId);
    const dispatch = decode<{ id: string; revision: number }>(slot);
    if (slot && dispatch?.id === active.id && dispatch.revision === active.revision) {
      const budget = await tx.get(budgetId);
      const quota = decode<Budget>(budget);
      if (budget && quota && result?.tokens != null) {
        const tokens = quota.tokens - reservedTokens + result.tokens;
        await tx.put(
          { ...budget, revision: budget.revision + 1, data: JSON.stringify({ ...quota, tokens }) },
          budget.revision,
        );
      }
      await tx.remove(slot.id, slot.revision);
    }
    if (result && (await authorize(job, tx).catch(() => null))) {
      const review: MemoryModelReview & { generation: number } = {
        ...result,
        conversationId: job.conversationId,
        messageId: job.messageId,
        generation: job.generation,
        finishedAt: now(),
        durationMs: Math.max(0, now() - startedAt),
      };
      await tx.put(
        {
          id: "memory-model-review:" + job.messageId,
          kind: modelReviewKind,
          owner: active.owner,
          revision: 1,
          updatedAt: review.finishedAt + reviewRetentionMs,
          data: JSON.stringify(review),
        },
        null,
      );
    }
    await tx.remove(active.id, active.revision);
  });
}
