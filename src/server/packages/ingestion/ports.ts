import type { SourceStagePurpose, SourceStageView } from "../../../shared/packages/stages/contracts.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type { SourceUploadBody } from "../uploads/contracts.js";
/** HTTP owns transport validation; ingestion owns admissions, leases and source access. */
export interface PackageSourceIngestionPort {
  submit(actor: string, purpose: SourceStagePurpose, operationId: string, input: unknown): Promise<SourceStageView>;
  read(actor: string, purpose: SourceStagePurpose, id: string): SourceStageView | Promise<SourceStageView>;
  list(actor: string, purpose: SourceStagePurpose): readonly SourceStageView[] | Promise<readonly SourceStageView[]>;
  inspect(actor: string, purpose: SourceStagePurpose, id: string): Promise<CapturedPackageSource["descriptor"]>;
  upload(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    revision: number,
    body: SourceUploadBody,
  ): Promise<SourceStageView>;
  cancel(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    revision: number,
  ): SourceStageView | Promise<SourceStageView>;
  remove(actor: string, purpose: SourceStagePurpose, id: string, revision: number): Promise<SourceStageView>;
}
