import type { EngineQuestion } from "../engine/questions.js";
import type { SkillCapability } from "../skills/contracts.js";

export interface CreationEngineProfile {
  id: string;
  engineId: string;
  model?: string;
}
export interface CreationSkillSelection {
  packageId: string;
  version: string;
  digest: string;
  id: string;
  parameters: Readonly<Record<string, string | number | boolean>>;
}
export interface CreationRequest {
  id: string;
  projectId: string;
  treeVersion: number;
  parentId: string | null;
  locale: string;
  prompt: string;
  profileId: string;
  selections: readonly CreationSkillSelection[];
}
export const DOCUMENT_CREATION_CAPABILITIES = ["project.documents.create"] as const;
export interface CreationAvailability {
  state: "ready" | "unavailable" | "unconfigured";
  profiles: CreationEngineProfile[];
  defaultProfileId: string | null;
  defaultWorkflow: CreationSkillSelection | null;
  capabilities: readonly SkillCapability[];
}
export type CreationTaskState = "queued" | "running" | "committing" | "succeeded" | "failed" | "cancelled";
export type CreationFailure = "interrupted" | "invalidOutput" | "targetChanged" | "writeUnavailable";
export interface CreationArtifact {
  kind: "document";
  projectId: string;
  documentId: string;
  operationId: string;
  treeVersion: number;
}
/** Browser state contains no execution lease, engine request IDs, source digests or selected skill instructions. */
export interface CreationTaskView {
  id: string;
  projectId: string;
  state: CreationTaskState;
  generation: number;
  prompt: string;
  model: string | null;
  cancelRequested: boolean;
  artifact: CreationArtifact | null;
  failure: CreationFailure | null;
  question: { id: string; questions: EngineQuestion[] } | null;
  createdAt: number;
  updatedAt: number;
}
