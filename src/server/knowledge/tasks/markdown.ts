import type { KnowledgeRecord } from "../../../shared/knowledge/tasks.js";

const literal = (text: string) => text.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&");
/** Readable source sits beside the structured record. Neither projection contains attachments or executable HTML. */
export function knowledgeMarkdown(record: KnowledgeRecord): string {
  const lines = ["# " + literal(record.draft.title), "", literal(record.draft.summary), "", "## Knowledge", ""];
  let reference = 0;
  for (const claim of record.draft.claims) {
    lines.push(
      "### " + { source: "Source", inference: "Inference", user: "User input" }[claim.kind],
      "",
      literal(claim.text),
      "",
    );
    for (const evidence of claim.evidence) {
      lines.push(
        "> " + literal(evidence.quote).replaceAll("\n", "\n> "),
        "",
        `[${++reference}] ${literal(evidence.sourceId)} · ${literal(evidence.version)} · ${evidence.start}–${evidence.end}`,
        "",
      );
    }
  }
  if (record.draft.uncertainties.length)
    lines.push("## Open questions", "", ...record.draft.uncertainties.map((question) => "- " + literal(question)), "");
  lines.push("---", "", "Knowledge version: " + record.version, "Source commit: " + record.sourceCommit, "");
  if (record.approval) lines.push("Approval: " + record.approval.mode, "");
  if (record.approval?.mode === "automatic")
    lines.push(
      "Review: " + record.approval.reviewId,
      "Review policy revision: " + record.approval.policyRevision,
      "Review report: " + record.approval.reportDigest,
      "",
    );
  if (record.review)
    lines.push(
      "## Automatic review",
      "",
      literal(record.review.summary),
      "",
      ...record.review.claims.map((claim) => "- " + literal(claim.id) + ": " + literal(claim.reason)),
      "",
    );
  return lines.join("\n");
}
