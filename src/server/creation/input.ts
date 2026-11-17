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
  profile: CreationEngineProfile;
  skills: SkillCapture;
  materials?: readonly import("../../shared/creation/contracts.js").CreationMaterial[];
  recoveryFrom?: { taskId: string; inputDigest: string };
  previous?: {
    prompt: string;
    document: { title: string; body: import("../../shared/documents/rich-body.js").RichDocumentBody };
  };
}
export interface CreationInputs {
  put(input: CreationInputSnapshot): Promise<string>;
  read(task: CreationTaskSpec): Promise<CreationInputSnapshot>;
}
