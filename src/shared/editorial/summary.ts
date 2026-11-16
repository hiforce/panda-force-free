import type { EditorialProposal, EditorialSummaryBase } from "./contracts.js";

/** Histories carry identity and provenance; text suggestions are loaded only when their review is selected. */
export function editorialSummary(proposal: EditorialProposal): EditorialSummaryBase {
  return {
    id: proposal.id,
    source: proposal.source,
    mode: proposal.mode,
    producer: proposal.producer,
    createdAt: proposal.createdAt,
  };
}
