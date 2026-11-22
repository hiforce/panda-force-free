import type { SkillCapture } from "../../shared/skills/registry.js";
import type { CreationTaskSpec } from "./contracts.js";

import type { CreationEngineProfile } from "../../shared/creation/contracts.js";
export type {
  CreationEngineProfile,
  CreationRequest,
  CreationSkillSelection,
} from "../../shared/creation/contracts.js";
export interface CreationInputSnapshot {
  schema: 1;
  taskId: string;
  owner: string;
  projectId: string;
  requestDigest: string;
  prompt: string;
  outputType?: import("../../shared/creation/contracts.js").CreationRequestedOutput;
  dialogue?: true;
  discussion?: readonly { user: string; assistant: string }[];
  documentFileLineage?: string;
  profile: CreationEngineProfile;
  skills: SkillCapture;
  materials?: readonly import("../../shared/creation/contracts.js").CreationMaterial[];
  recoveryFrom?: { taskId: string; inputDigest: string };
  previous?: {
    prompt: string;
    document: { title: string; body: import("../../shared/documents/rich-body.js").RichDocumentBody };
  };
  previousAsset?: {
    taskId: string;
    prompt: string;
    artifact: import("../../shared/creation/contracts.js").CreationAssetArtifact;
  };
}
export interface CreationInputs {
  put(input: CreationInputSnapshot): Promise<string>;
  read(task: CreationTaskSpec): Promise<CreationInputSnapshot>;
}
