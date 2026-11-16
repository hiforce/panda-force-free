import { knowledgeSourceBinding } from "../../../shared/knowledge/source-binding.js";
import { createHash } from "node:crypto";
import type {
  KnowledgeDraft,
  KnowledgeEvidence,
  KnowledgeEvidenceSource,
} from "../../../shared/knowledge/contracts.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";
import type { KnowledgeRecord } from "../../../shared/knowledge/tasks.js";
import {
  knowledgeDigest,
  knowledgeId,
  knowledgeObject,
  knowledgeText,
} from "../../../shared/knowledge/task-validation.js";
import { knowledgeDraft } from "../../../shared/knowledge/validation.js";
import { stableJson } from "../../../shared/stable-json.js";
import { knowledgeApproval, knowledgeReviewReport, knowledgeReviewVerdict } from "../../../shared/knowledge/review.js";
import { knowledgeValueDigest } from "../identity.js";

type Metadata = Omit<KnowledgeEvidenceSource, "text" | "sections">;
export function knowledgeSourceMetadata(value: unknown): Metadata {
  const p = knowledgeObject(value, ["id", "version", "kind", "title", "binding"]);
  if ((p.kind !== "asset" && p.kind !== "user-input") || (p.binding !== undefined && p.kind !== "asset"))
    throw new KnowledgeError("invalidInput");
  return {
    id: knowledgeId(p.id),
    version: knowledgeText(p.version, 160),
    kind: p.kind,
    title: knowledgeText(p.title, 2000),
    ...(p.binding === undefined ? {} : { binding: knowledgeSourceBinding(p.binding, knowledgeId(p.id)) }),
  };
}

function evidence(value: unknown, sources: Metadata[]): KnowledgeEvidence {
  const e = knowledgeObject(value, ["sourceId", "version", "kind", "digest", "start", "end", "quote", "section"]),
    sourceId = knowledgeId(e.sourceId),
    source = sources.find((source) => source.id === sourceId),
    quote = knowledgeText(e.quote, 4000),
    version = knowledgeText(e.version, 160);
  if (
    !source ||
    source.version !== version ||
    source.kind !== e.kind ||
    !Number.isSafeInteger(e.start) ||
    !Number.isSafeInteger(e.end) ||
    Number(e.start) < 0 ||
    Number(e.end) !== Number(e.start) + quote.length
  )
    throw new KnowledgeError("invalidInput");
  return {
    sourceId,
    version,
    kind: source.kind,
    digest: knowledgeDigest(e.digest),
    start: Number(e.start),
    end: Number(e.end),
    quote,
    ...(e.section === undefined ? {} : { section: knowledgeText(e.section, 160) }),
  };
}

/** Committed provenance is a bounded closed format; only review admission can approve an evidence-checked draft. */
export function knowledgeRecord(value: unknown): KnowledgeRecord {
  const p = knowledgeObject(value, [
    "schema",
    "id",
    "version",
    "previousVersion",
    "taskId",
    "sourceCommit",
    "sources",
    "draft",
    "approvedAt",
    "approval",
    "review",
  ]);
  if (
    p.schema !== 1 ||
    !Array.isArray(p.sources) ||
    !p.sources.length ||
    p.sources.length > 64 ||
    !Number.isSafeInteger(p.approvedAt) ||
    Number(p.approvedAt) < 0
  )
    throw new KnowledgeError("invalidInput");
  const sources = p.sources.map(knowledgeSourceMetadata);
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new KnowledgeError("invalidInput");
  const d = knowledgeObject(p.draft, ["schema", "title", "summary", "claims", "uncertainties"]);
  if (!Array.isArray(d.claims) || d.claims.length > 64) throw new KnowledgeError("invalidInput");
  const claims = d.claims.map((value) => {
    const c = knowledgeObject(value, ["id", "kind", "text", "evidence"]);
    if (!Array.isArray(c.evidence) || c.evidence.length > 16) throw new KnowledgeError("invalidInput");
    return { ...c, evidence: c.evidence.map((value) => evidence(value, sources)) };
  });
  const input = knowledgeDraft({
    ...d,
    claims: claims.map((c) => ({
      ...c,
      evidence: c.evidence.map((e) => ({
        sourceId: e.sourceId,
        version: e.version,
        quote: e.quote,
        start: e.start,
        ...(e.section === undefined ? {} : { section: e.section }),
      })),
    })),
  });
  const draft: KnowledgeDraft = {
    ...input,
    claims: input.claims.map((claim, i) => ({ ...claim, evidence: claims[i]!.evidence })),
  };
  for (const claim of draft.claims)
    if (
      (claim.kind === "source" && (!claim.evidence.length || claim.evidence.some((e) => e.kind !== "asset"))) ||
      (claim.kind === "user" && (!claim.evidence.length || claim.evidence.some((e) => e.kind !== "user-input")))
    )
      throw new KnowledgeError("invalidInput");
  const record: KnowledgeRecord = {
    schema: 1,
    id: knowledgeId(p.id),
    version: knowledgeDigest(p.version),
    previousVersion: p.previousVersion === null ? null : knowledgeDigest(p.previousVersion),
    taskId: knowledgeId(p.taskId),
    sourceCommit: knowledgeText(p.sourceCommit, 160),
    sources,
    draft,
    approvedAt: Number(p.approvedAt),
    ...(p.approval === undefined ? {} : { approval: knowledgeApproval(p.approval) }),
    ...(p.review === undefined ? {} : { review: knowledgeReviewReport(p.review) }),
  };
  if (record.approval?.mode === "automatic") {
    const review = record.review;
    if (
      !review ||
      review.verdict !== "approve" ||
      review.id !== record.approval.reviewId ||
      review.taskId !== record.taskId ||
      review.policyRevision !== record.approval.policyRevision ||
      review.engineId !== record.approval.engineId ||
      review.model !== record.approval.model ||
      review.reviewedAt !== record.approvedAt ||
      knowledgeValueDigest(review) !== record.approval.reportDigest
    )
      throw new KnowledgeError("invalidInput");
    knowledgeReviewVerdict(
      {
        schema: review.schema,
        verdict: review.verdict,
        summary: review.summary,
        checks: review.checks,
        claims: review.claims,
        issues: review.issues,
      },
      record.draft,
    );
  } else if (record.review) throw new KnowledgeError("invalidInput");
  if (Buffer.byteLength(stableJson(record)) > 1024 * 1024 || knowledgeRecordVersion(record) !== record.version)
    throw new KnowledgeError("invalidInput");
  return record;
}

export function knowledgeRecordVersion(record: Omit<KnowledgeRecord, "version"> | KnowledgeRecord): string {
  const { schema, id, previousVersion, taskId, sourceCommit, sources, draft, approvedAt, approval, review } = record;
  return createHash("sha256")
    .update(
      stableJson({
        schema,
        id,
        previousVersion,
        taskId,
        sourceCommit,
        sources,
        draft,
        approvedAt,
        ...(approval === undefined ? {} : { approval }),
        ...(review === undefined ? {} : { review }),
      }),
    )
    .digest("hex");
}
