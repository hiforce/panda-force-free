import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type { SourceLimits, SourceEntryPolicy } from "../../../shared/packages/sources/contracts.js";
import type { SourceUploadBody, SourceUploadIdentity } from "../uploads/contracts.js";
import type {
  SourceStageEvent,
  SourceStageFailure,
  SourceStageRequest,
  SourceStageView,
  SourceStagePurpose,
} from "../../../shared/packages/stages/contracts.js";

export interface SourceStageClaim {
  readonly stage: SourceStageView;
  readonly token: string;
  readonly expiresAt: number;
}
export interface SourceStageCandidate {
  readonly actor: string;
  readonly id: string;
  readonly purpose: SourceStagePurpose;
  readonly revision: number;
  readonly state: SourceStageView["state"];
}
export interface SourceStageCreation {
  readonly actor: string;
  readonly id: string;
  readonly operationId: string;
  readonly purpose: SourceStagePurpose;
  readonly request: SourceStageRequest;
  readonly limits: SourceLimits;
  readonly fingerprint: string;
  readonly reservedBytes: number;
  readonly now: number;
}
export interface SourceStageStore {
  candidates(now: number): readonly SourceStageCandidate[];
  operation(actor: string, operationId: string): SourceStageView | null;
  replay(actor: string, operationId: string, fingerprint: string): SourceStageView | null;
  create(value: SourceStageCreation, prepare: (id: string) => void): SourceStageView;
  read(actor: string, id: string): SourceStageView;
  list(actor: string, purpose: SourceStagePurpose): readonly SourceStageView[];
  events(actor: string, id: string): readonly SourceStageEvent[];
  claim(actor: string, id: string, revision: number, now: number, leaseMs: number): SourceStageClaim;
  claimUpload(actor: string, id: string, revision: number, now: number, leaseMs: number): SourceStageClaim;
  uploaded(actor: string, claim: SourceStageClaim, now: number): SourceStageView;
  restoreUpload(actor: string, id: string, revision: number, now: number): SourceStageView;
  bind(actor: string, claim: SourceStageClaim, digest: string, now: number): SourceStageView;
  complete(
    actor: string,
    claim: SourceStageClaim,
    source: CapturedPackageSource,
    bytes: number,
    now: number,
  ): SourceStageView;
  fail(actor: string, claim: SourceStageClaim, failure: SourceStageFailure, now: number): void;
  recover(
    actor: string,
    id: string,
    revision: number,
    source: CapturedPackageSource,
    bytes: number,
    now: number,
  ): SourceStageView;
  recovery(actor: string, id: string, revision: number, now: number): SourceStageView;
  cancel(actor: string, id: string, revision: number, now: number): SourceStageView;
  removing(actor: string, id: string, revision: number, now: number): SourceStageView;
  removed(actor: string, id: string, revision: number, now: number): SourceStageView;
}
export interface SourceStageFiles {
  reserve(request: SourceStageRequest, limits: SourceLimits): number;
  size(source: CapturedPackageSource): number;
  prepare(id: string): void;
  put(id: string, source: CapturedPackageSource, limits: SourceLimits): Promise<void>;
  read(id: string, digest: string, limits: SourceLimits): Promise<CapturedPackageSource>;
  recover(id: string, digest: string, limits: SourceLimits): Promise<CapturedPackageSource>;
  upload(id: string, expected: SourceUploadIdentity, body: SourceUploadBody, signal: AbortSignal): Promise<void>;
  original(id: string, expected: SourceUploadIdentity, signal: AbortSignal): Promise<Uint8Array>;
  recoverOriginal(id: string, expected: SourceUploadIdentity, signal: AbortSignal): Promise<void>;
  dropOriginal(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export type SourceStageAcquisition = (
  actor: string,
  purpose: SourceStagePurpose,
  request: SourceStageRequest,
  signal: AbortSignal,
  limits: SourceLimits,
  entryPolicy: SourceEntryPolicy,
) => Promise<CapturedPackageSource>;
