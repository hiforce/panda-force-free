import type { EditorialProposal } from "../../../shared/editorial/contracts.js";
import type { EditorialProcessingProfile } from "../../../shared/editorial/jobs.js";

export type ModelEditorialMode = "proofread" | "rewrite";
export type EditorialModelProfile = EditorialProcessingProfile;
export interface EditorialSegment {
  id: string;
  path: number[];
  start: number;
  text: string;
}
export interface EditorialModelInput {
  schema: 1;
  mode: ModelEditorialMode;
  segments: EditorialSegment[];
  truncated: boolean;
}
export interface EditorialModelRun {
  operationId: string;
  attempt: number;
  generation: number;
  signal: AbortSignal;
}
/** Only isolated, explicitly configured adapters may implement this port; coding sessions are not processors. */
export interface EditorialModel {
  profile: Readonly<EditorialModelProfile>;
  process(input: EditorialModelInput, run: EditorialModelRun): Promise<unknown>;
}
export type PreparedEditorial = Pick<EditorialProposal, "producer" | "edits" | "truncated">;
export class EditorialModelOutputError extends Error {}

/** Adapters can constrain generation with this schema; application validation remains authoritative. */
export const EDITORIAL_MODEL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["edits"],
  properties: {
    edits: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segmentId", "before", "after", "reason"],
        properties: {
          segmentId: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;
