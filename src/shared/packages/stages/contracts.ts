import type { PackageSourceOrigin, SourceErrorCode, SourceLimits, SourceEntryPolicy } from "../sources/contracts.js";

export type SourceStagePurpose = "templates" | "skills";
export type SourceStageState =
  | "reserved"
  | "uploading"
  | "uploaded"
  | "acquiring"
  | "writing"
  | "ready"
  | "failed"
  | "cancelled"
  | "removing"
  | "removed";
export type SourceStageFailure = SourceErrorCode | "interrupted" | "storageUnavailable";
export interface SourceStageRequest {
  readonly source:
    | { readonly kind: "zip-upload"; readonly name: string; readonly bytes: number; readonly sha256: string }
    | {
        readonly kind: "github";
        readonly repository: string;
        readonly ref: string | null;
        readonly root: string;
        readonly connectionId: string | null;
        readonly repositoryId: number | null;
      };
  readonly selected: readonly string[] | null;
}
export interface SourceStageView {
  readonly entryPolicy: SourceEntryPolicy;
  readonly id: string;
  readonly purpose: SourceStagePurpose;
  readonly revision: number;
  readonly state: SourceStageState;
  readonly request: SourceStageRequest;
  readonly limits: SourceLimits;
  readonly reservedBytes: number;
  readonly digest: string | null;
  readonly origin: Readonly<PackageSourceOrigin> | null;
  readonly failure: SourceStageFailure | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface SourceStageEvent {
  readonly revision: number;
  readonly state: SourceStageState;
  readonly at: number;
  readonly digest: string | null;
  readonly failure: SourceStageFailure | null;
}
export type SourceStageErrorCode =
  "stageInvalidInput" | "stageNotFound" | "stageConflict" | "stageCapacity" | "stageBusy" | "stageUnavailable";
export class SourceStageError extends Error {
  constructor(readonly code: SourceStageErrorCode) {
    super(code);
    this.name = "SourceStageError";
  }
}
