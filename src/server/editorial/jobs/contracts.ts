import type { EditorialJob, EditorialJobState, EditorialJobFailure } from "../../../shared/editorial/jobs.js";
import type { EditorialSource } from "../ports.js";
import type { EditorialModelProfile, ModelEditorialMode } from "../model/contracts.js";

export interface EditorialJobSpec {
  schema: 1;
  id: string;
  proposalId: string;
  source: Pick<EditorialSource, "ref">;
  mode: ModelEditorialMode;
  profile: EditorialModelProfile;
}
export interface EditorialJobRow {
  id: string;
  owner: string;
  documentId: string;
  request: string;
  payload: string;
  digest: string;
  state: EditorialJobState;
  attempts: number;
  generation: number;
  budget: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  proposalId: string | null;
  failure: EditorialJobFailure | null;
  createdAt: number;
  updatedAt: number;
  sourceProjectId: string | null;
}
export interface EditorialJobRecord {
  row: EditorialJobRow;
  spec: EditorialJobSpec;
  job: EditorialJob;
}
export interface EditorialClaim extends EditorialJobRecord {
  token: string;
}
export class EditorialLeaseLost extends Error {}
