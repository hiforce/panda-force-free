import type { EditorialProcessingProfile } from "../../../shared/editorial/jobs.js";
import type { EditorialModel } from "./contracts.js";

export const HARNESS_EDITORIAL_PROFILE = "__harness_runtime__";
export interface EditorialRuntimePort {
  resolve(
    owner: string,
    selection: { runtimeId?: string; model?: string; effort?: string },
  ): Promise<EditorialProcessingProfile>;
  model(owner: string, profile: EditorialProcessingProfile): EditorialModel;
}
