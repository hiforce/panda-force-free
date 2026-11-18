import type { EngineQuestion } from "../engine/questions.js";
import type { SkillCapability } from "../skills/contracts.js";
import type { ComposerAttachment } from "../data-contracts.js";
import type { TokenUsage } from "../engine/types.js";

export const CREATION_OUTPUT_TYPES = ["document", "image", "slides", "video", "web"] as const;
export type CreationOutputType = (typeof CREATION_OUTPUT_TYPES)[number];
export type CreationRequestedOutput = CreationOutputType | "auto";

export interface CreationEngineProfile {
  id: string;
  engineId: string;
  model?: string;
  effort?: string;
}
export interface CreationMaterial {
  id: string;
  name: string;
  kind: "image" | "file";
  digest: string;
}
export interface CreationSkillSelection {
  packageId: string;
  version: string;
  digest: string;
  id: string;
  parameters: Readonly<Record<string, string | number | boolean>>;
}
export interface CreationSkillSummary {
  selection: CreationSkillSelection;
  name: Readonly<Record<string, string>>;
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
  previousTaskId?: string;
  model?: string;
  effort?: string;
  attachments?: readonly { materialId: string }[];
  outputType?: CreationRequestedOutput;
}
export const DOCUMENT_CREATION_CAPABILITIES = ["project.documents.create"] as const;
export interface CreationAvailability {
  state: "ready" | "unavailable" | "unconfigured";
  profiles: CreationEngineProfile[];
  defaultProfileId: string | null;
  defaultWorkflow: CreationSkillSelection | null;
  capabilities: readonly SkillCapability[];
  outputTypes?: readonly CreationOutputType[];
}
export type CreationTaskState = "queued" | "running" | "committing" | "succeeded" | "failed" | "cancelled";
export type CreationFailure =
  "interrupted" | "timedOut" | "invalidOutput" | "targetChanged" | "fileChanged" | "writeUnavailable";
export interface CreationGoal {
  id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "completed";
  updatedAt: number;
}
export interface CreationGoalCommand {
  id: string;
  action: "set" | "create" | "pause" | "resume" | "clear";
  objective?: string;
  model?: string;
  effort?: string;
}
export interface CreationProgress {
  at: number;
  generation: number;
  stage: "started" | "saving" | "waiting" | "answered" | "message" | "usage";
  text?: string;
  id?: string;
  streaming?: boolean;
  usage?: TokenUsage;
}
export interface CreationDocumentArtifact {
  kind: "document";
  projectId: string;
  documentId: string;
  operationId: string;
  treeVersion: number;
  title?: string;
  revisionId?: string;
  revision?: number;
  file?: { path: string; format: "markdown" };
  location?: { projectId: string; operationId: string; treeVersion: number; revisionId: string; revision: number };
}
export interface CreationAssetArtifact {
  kind: Exclude<CreationOutputType, "document">;
  projectId: string;
  assetId: string;
  operationId: string;
  version: string;
  commit: string;
  title: string;
  source: { name: string; digest: string; size: number };
}
export type CreationArtifact = CreationDocumentArtifact | CreationAssetArtifact;
export function creationDocumentArtifact(value: CreationArtifact | null | undefined): CreationDocumentArtifact | null {
  return value?.kind === "document" ? value : null;
}
/** Browser state contains no execution lease, engine request IDs, source digests or selected skill instructions. */
export interface CreationTaskView {
  id: string;
  projectId: string;
  state: CreationTaskState;
  generation: number;
  prompt: string;
  outputType?: CreationRequestedOutput;
  goal?: CreationGoal | null;
  model: string | null;
  effort?: string | null;
  cancelRequested: boolean;
  artifact: CreationArtifact | null;
  failure: CreationFailure | null;
  question: { id: string; questions: EngineQuestion[] } | null;
  createdAt: number;
  updatedAt: number;
  previousTaskId?: string;
  document?: { documentId: string; title: string; revision: number; projectId?: string; projectName?: string };
  documentStatus?: "available" | "unavailable";
}
export interface CreationTaskDetail extends CreationTaskView {
  workspaceDirectory?: string;
  goalVersion?: number;
  messages?: {
    id: string;
    text: string;
    state: "received" | "dispatching" | "delivered" | "uncertain";
    createdAt: number;
    updatedAt: number;
    selections: CreationSkillSelection[];
    skillSummaries?: CreationSkillSummary[];
    attachments: ComposerAttachment[];
  }[];
  selections?: CreationSkillSelection[];
  skillSummaries?: CreationSkillSummary[];
  attachments?: ComposerAttachment[];
  usage?: TokenUsage;
  progress: CreationProgress[];
  clarifications: {
    questions: EngineQuestion[];
    answers: Record<string, { answers: string[] }>;
    askedAt?: number;
    answeredAt?: number | null;
  }[];
}
