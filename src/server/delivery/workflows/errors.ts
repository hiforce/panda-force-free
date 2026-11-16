import { DeliveryError } from "../errors.js";

/** Only a definitive rejection permits an explicitly requested retry. */
export class RemoteOperationError extends DeliveryError {
  constructor(
    code: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(code, 409);
  }
}

/** Releases the execution lease while an already authorized workflow awaits a safe read-only check. */
export class WorkflowDeferred extends Error {
  constructor(readonly until: number) {
    super("Workflow is waiting");
  }
}
