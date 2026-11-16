import type { SearchJobRow } from "../state.js";
import { searchSettings } from "../../../shared/search/validation.js";

export interface ProjectPolicy {
  key: string;
  source: string;
  project: string;
  owner: string;
  settings: string;
  revision: number;
  needsReview: number;
  updatedAt: number;
}

/** A batch lookup must retain every field check enforced by the single-scope path. */
export function validSearchProjectPolicy(row: SearchJobRow, policy?: ProjectPolicy | null) {
  if (
    row.project !== "personal" &&
    (!policy ||
      policy.key !== row.key ||
      policy.source !== row.source ||
      policy.project !== row.project ||
      policy.owner !== row.owner ||
      policy.settings !== row.settings ||
      policy.revision !== row.revision ||
      (policy.needsReview === 1 && row.state !== "needsReview"))
  )
    return false;
  try {
    searchSettings(JSON.parse(row.settings));
    return true;
  } catch {
    return false;
  }
}
