import type { EditorialSourceRef } from "./contracts.js";

export type EditorialJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface EditorialProcessingProfile {
  id: string;
  engine: string;
  model: string;
  version: string;
}
export type EditorialJobFailure =
  "interrupted" | "processorUnavailable" | "invalidOutput" | "timeout" | "processingFailed";
/** Public job state contains no lease tokens, private adapter configuration or raw provider errors. */
export interface EditorialJob {
  id: string;
  source: EditorialSourceRef;
  mode: "proofread" | "rewrite";
  profile: EditorialProcessingProfile;
  state: EditorialJobState;
  attempts: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  proposalId: string | null;
  failure: EditorialJobFailure | null;
}
