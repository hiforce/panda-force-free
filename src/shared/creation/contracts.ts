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
  media?: { model: string; effort?: string };
  runtimeId?: string;
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
  runtimeId?: string;
  model?: string;
  effort?: string;
  attachments?: readonly { materialId: string }[];
  outputType?: CreationRequestedOutput;
  media?: import("./media-executors.js").CreationMediaChoice;
  dialogue?: true;
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
export type CreationTaskState = "queued" | "running" | "committing" | "succeeded" | "replied" | "failed" | "cancelled";
export type CreationFailure =
  "interrupted" | "timedOut" | "inactive" | "invalidOutput" | "targetChanged" | "fileChanged" | "writeUnavailable";
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
  runtimeId?: string;
  model?: string;
  effort?: string;
}
export interface CreationProgress {
  at: number;
  generation: number;
  stage: "preparing" | "started" | "saving" | "waiting" | "answered" | "message" | "reply" | "usage" | "activity";
  text?: string;
  id?: string;
  streaming?: boolean;
  phase?: "commentary" | "final_answer";
  usage?: TokenUsage;
  operation?: import("./progress.js").CreationOperation;
  status?: "running" | "completed" | "failed";
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
export interface CreationIdentity {
  id: string;
  prompt: string;
  createdAt: number;
  rounds: number;
}
export interface CreationConversationPage {
  creation: CreationIdentity;
  latestTaskId: string;
  ids: string[];
  nextCursor: string | null;
}
/** Browser state contains no execution lease, engine request IDs, source digests or selected skill instructions. */
export interface CreationTaskView {
  creation?: CreationIdentity;
  id: string;
  projectId: string;
  state: CreationTaskState;
  generation: number;
  prompt: string;
  outputType?: CreationRequestedOutput;
  media?: import("./media-executors.js").CreationMediaChoice;
  goal?: CreationGoal | null;
  runtimeId?: string;
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
export interface CreationNotification {
  taskId: string;
  generation: number;
  createdAt: number;
  readAt: number | null;
  title: string;
  kind: CreationOutputType;
  artifact: CreationArtifact;
}
/** A queued round takes its generation when a worker claims it. */
export function creationUpdateGeneration(task: { state: string; generation: number }): number {
  return task.state === "queued" ? task.generation + 1 : task.generation;
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
