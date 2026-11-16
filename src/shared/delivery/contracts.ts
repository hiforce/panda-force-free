import type { SiteBuild } from "../builds/jobs.js";
import type { PublicationConnection } from "../connections/contracts.js";

export interface SitePublicationRequest {
  projectId?: string;
  id: string;
  buildId: string;
  connectionId: string;
  connectionVersion: number;
}
/** A plan is immutable. Mutable execution state and external receipts are separate records. */
export interface SitePublicationPlan extends SitePublicationRequest {
  projectId: string;
  /** Missing on legacy plans. Never infer a storage route from the current project binding. */
  sourceProjectId?: string;
  spaceId: string;
  connection: PublicationConnection;
  build: Pick<SiteBuild, "id" | "site" | "engine" | "inputHash" | "sources" | "image" | "sourceSnapshot">;
  fingerprint: string;
  fileCount: number;
  outputBytes: number;
  servedPath: string;
  createdAt: number;
  expiresAt: number;
}
export type PublicationPhase =
  "prepared" | "queued" | "running" | "reconciling" | "published" | "failed" | "cancelled" | "needsAttention";
export interface PublicationReceipt {
  verification: "local-files" | "sftp-files";
  releaseId: string;
  fingerprint: string;
  publicUrl: string;
  servedPath: string;
  previousRelease: string | null;
  publishedAt: number;
}
export interface PublicationJob {
  id: string;
  phase: PublicationPhase;
  step: "staging" | "activating" | null;
  updatedAt: number;
  error: string | null;
  receipt: PublicationReceipt | null;
}
export interface SitePublication {
  plan: SitePublicationPlan;
  job: PublicationJob;
}
