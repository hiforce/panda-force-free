export interface EditorialSourceRef {
  projectId?: string;
  documentId: string;
  revisionId: string;
  sourceHash: string;
  version: number;
}
export type EditorialMode = "spacing" | "proofread" | "rewrite" | "translate";
export interface RichTextEdit {
  id: string;
  path: number[];
  start: number;
  end: number;
  before: string;
  after: string;
  rule: "repeatedSpaces" | "trailingWhitespace" | "spelling" | "punctuation" | "grammar" | "rewrite" | "translate";
  reason?: string;
  contextBefore?: string;
  contextAfter?: string;
}
export interface EditorialProposal {
  schema: 1;
  id: string;
  source: EditorialSourceRef;
  mode: EditorialMode;
  producer: { kind: "rules"; version: string } | { kind: "model"; engine: string; model: string; version: string };
  edits: RichTextEdit[];
  truncated: boolean;
  createdAt: number;
}
export interface EditorialReceipt {
  proposalId: string;
  digest: string;
  source: EditorialSourceRef;
  selected: string[];
  applied: EditorialSourceRef;
  reviewer: string;
  appliedAt: number;
  commit?: string;
}
export type EditorialApplicationIntent = Omit<EditorialReceipt, "applied" | "commit">;
export interface EditorialDetail {
  proposal: EditorialProposal;
  digest: string;
  stale: boolean;
  receipt: EditorialReceipt | null;
  pending?: { selected: string[]; appliedAt: number };
}
export type EditorialSummaryBase = Pick<EditorialProposal, "id" | "source" | "mode" | "producer" | "createdAt">;
export interface EditorialSummary extends EditorialSummaryBase {
  applied: boolean;
  stale: boolean;
}
export interface EditorialHistoryPage {
  reviews: EditorialSummary[];
  nextCursor: string | null;
}
