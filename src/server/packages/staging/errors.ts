import { SourceError } from "../../../shared/packages/sources/contracts.js";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";

export function stageError(error: unknown): Error {
  return error instanceof SourceError || error instanceof SourceStageError
    ? error
    : new SourceStageError("stageUnavailable");
}
