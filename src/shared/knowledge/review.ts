import type { KnowledgeDraftInput } from "./contracts.js";
import { KnowledgeError } from "./contracts.js";
import { knowledgeDigest, knowledgeId, knowledgeObject, knowledgeText } from "./primitives.js";

export interface KnowledgeReviewPolicy {
  automatic: boolean;
  revision: number;
}
export type KnowledgeAutomaticReviewState = "running" | "passed" | "needsReview" | "failed" | "superseded";
export interface KnowledgeAutomaticReview {
  id: string;
  taskRevision: number;
  policyRevision: number;
  state: KnowledgeAutomaticReviewState;
  createdAt: number;
  finishedAt: number | null;
}
export interface KnowledgeReviewVerdict {
  schema: 1;
  verdict: "approve" | "needsReview";
  summary: string;
  checks: { faithfulness: boolean; coverage: boolean; separation: boolean; clarity: boolean; contradictions: boolean };
  claims: { id: string; supported: boolean; reason: string }[];
  issues: string[];
}
export interface KnowledgeReviewReport extends KnowledgeReviewVerdict {
  id: string;
  taskId: string;
  taskRevision: number;
  policyRevision: number;
  inputDigest: string;
  dialogueDigest: string;
  draftDigest: string;
  engineId: string;
  model: string;
  reviewedAt: number;
}
export type KnowledgeApproval =
  | { mode: "manual" }
  | {
      mode: "automatic";
      reviewId: string;
      policyRevision: number;
      reportDigest: string;
      engineId: string;
      model: string;
    };

const positive = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new KnowledgeError("invalidInput");
  return Number(value);
};
export function knowledgeApproval(value: unknown): KnowledgeApproval {
  const p = knowledgeObject(value, ["mode", "reviewId", "policyRevision", "reportDigest", "engineId", "model"]);
  if (p.mode === "manual" && Object.keys(p).length === 1) return { mode: "manual" };
  if (p.mode !== "automatic") throw new KnowledgeError("invalidInput");
  return {
    mode: "automatic",
    reviewId: knowledgeId(p.reviewId),
    policyRevision: positive(p.policyRevision),
    reportDigest: knowledgeDigest(p.reportDigest),
    engineId: knowledgeId(p.engineId),
    model: knowledgeText(p.model, 128),
  };
}

/** Every claim and every document-level check must pass; confidence scores cannot authorize approval. */
export function knowledgeReviewVerdict(value: unknown, draft?: KnowledgeDraftInput): KnowledgeReviewVerdict {
  const p = knowledgeObject(value, ["schema", "verdict", "summary", "checks", "claims", "issues"]),
    checks = knowledgeObject(p.checks, ["faithfulness", "coverage", "separation", "clarity", "contradictions"]);
  if (
    p.schema !== 1 ||
    !["approve", "needsReview"].includes(String(p.verdict)) ||
    Object.keys(checks).length !== 5 ||
    Object.values(checks).some((value) => typeof value !== "boolean") ||
    !Array.isArray(p.claims) ||
    !p.claims.length ||
    p.claims.length > 64 ||
    !Array.isArray(p.issues) ||
    p.issues.length > 32
  )
    throw new KnowledgeError("invalidInput");
  const claims = p.claims.map((value) => {
      const c = knowledgeObject(value, ["id", "supported", "reason"]);
      if (typeof c.supported !== "boolean") throw new KnowledgeError("invalidInput");
      return { id: knowledgeId(c.id), supported: c.supported, reason: knowledgeText(c.reason, 1000) };
    }),
    issues = p.issues.map((value) => knowledgeText(value, 2000));
  if (
    new Set(claims.map((c) => c.id)).size !== claims.length ||
    (draft && (claims.length !== draft.claims.length || draft.claims.some((c) => !claims.some((v) => v.id === c.id))))
  )
    throw new KnowledgeError("invalidInput");
  if (
    p.verdict === "approve" &&
    (Object.values(checks).some((value) => !value) ||
      claims.some((c) => !c.supported) ||
      issues.length ||
      draft?.uncertainties.length ||
      draft?.claims.some((claim) => claim.kind === "inference" && !claim.evidence.length))
  )
    throw new KnowledgeError("invalidInput");
  return {
    schema: 1,
    verdict: p.verdict as KnowledgeReviewVerdict["verdict"],
    summary: knowledgeText(p.summary, 4000),
    checks: checks as KnowledgeReviewVerdict["checks"],
    claims,
    issues,
  };
}

export function knowledgeReviewReport(value: unknown): KnowledgeReviewReport {
  const p = knowledgeObject(value, [
      "schema",
      "verdict",
      "summary",
      "checks",
      "claims",
      "issues",
      "id",
      "taskId",
      "taskRevision",
      "policyRevision",
      "inputDigest",
      "dialogueDigest",
      "draftDigest",
      "engineId",
      "model",
      "reviewedAt",
    ]),
    { schema, verdict, summary, checks, claims, issues } = p;
  if (!Number.isSafeInteger(p.reviewedAt) || Number(p.reviewedAt) < 0) throw new KnowledgeError("invalidInput");
  return {
    ...knowledgeReviewVerdict({ schema, verdict, summary, checks, claims, issues }),
    id: knowledgeId(p.id),
    taskId: knowledgeId(p.taskId),
    taskRevision: positive(p.taskRevision),
    policyRevision: positive(p.policyRevision),
    inputDigest: knowledgeDigest(p.inputDigest),
    dialogueDigest: knowledgeDigest(p.dialogueDigest),
    draftDigest: knowledgeDigest(p.draftDigest),
    engineId: knowledgeId(p.engineId),
    model: knowledgeText(p.model, 128),
    reviewedAt: Number(p.reviewedAt),
  };
}
