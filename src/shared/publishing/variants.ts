import type { ContentVariant } from "./content.js";

export interface VariantReview {
  digest: string;
  reviewer: string;
  reviewedAt: number;
  acceptedIssues: string[];
}
export interface VariantDetail {
  variant: ContentVariant;
  digest: string;
  stale: boolean;
  review: VariantReview | null;
}
export interface VariantSummary {
  id: string;
  revisionId: string;
  format: ContentVariant["format"];
  templateId: string;
  templateVersion?: string;
  title: string;
  createdAt: number;
}
export type VariantExport = "html" | "text" | "bundle";
