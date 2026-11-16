import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { WorkflowRecord } from "../../shared/delivery/workflow.js";
import { executionWorkflowSteps } from "../../shared/delivery/recovery.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

export const canSubmit = (record: WorkflowRecord) =>
  !record.cancellation &&
  !record.lineage?.successorId &&
  record.plan.expiresAt > Date.now() &&
  ["prepared", "failed"].includes(record.phase);
export const publishedPost = (record: WorkflowRecord, index: number) =>
  executionWorkflowSteps(record).some(
    (step) => new RegExp(`^post\\.${index + 1}(?:\\.g[1-9][0-9]*)?$`).test(step.key) && step.outcome === "succeeded",
  );
export const relatedPlan = (t: Translate, key: MessageId, id: string, kind: string) =>
  `<button type="button" class="wb-button social-related-plan" data-social-action="related" data-id="${e(id)}" data-kind="${e(kind)}">${m(key, undefined, t)}</button>`;

/** Continuing creates a reviewable plan; publication remains a separate confirmation. */
export function continuationView(t: Translate, record: WorkflowRecord) {
  const lineage = record.lineage,
    expired = record.plan.expiresAt <= Date.now(),
    unknown = executionWorkflowSteps(record).some((step) => step.outcome === "pending"),
    eligible =
      !lineage?.successorId &&
      Boolean(record.continuationToken) &&
      (["failed", "cancelled", "needsAttention"].includes(record.phase) || (expired && record.phase === "prepared"));
  if (!lineage?.predecessorId && !lineage?.successorId && !eligible) return "";
  return `<section class="social-continuation">
  ${lineage?.predecessorId ? `<p>${m("social.continuationInheritedHint", undefined, t)}</p>${relatedPlan(t, "social.previousPlan", lineage.predecessorId, record.plan.kind)}` : ""}
  ${lineage?.successorId ? `<p>${m("social.supersededHint", undefined, t)}</p>${relatedPlan(t, "social.nextPlan", lineage.successorId, record.plan.kind)}` : ""}
  ${
    eligible
      ? `<h4>${m("social.continuationTitle", undefined, t)}</h4><p>${m(unknown ? "social.continuationUnknown" : "social.continuationHint", undefined, t)}</p>
  ${unknown ? "" : `<button type="button" class="wb-button" data-social-action="successor">${m("social.reviewContinuation", undefined, t)}</button>`}`
      : ""
  }</section>`;
}
