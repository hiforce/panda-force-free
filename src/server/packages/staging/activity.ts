import { SourceStageError } from "../../../shared/packages/stages/contracts.js";
import { LocalNamespaceActivity, type NamespaceActivity } from "../namespace-activity.js";

export type SourceNamespaceActivity = NamespaceActivity;

/** One state root has one file owner. Shared callers use this coordinator, never separate invisible globals. */
export class LocalSourceNamespaceActivity extends LocalNamespaceActivity {
  constructor() {
    super(() => new SourceStageError("stageConflict"));
  }
}
