import { CREATION_OUTPUT_TYPES, type CreationRequestedOutput } from "../../shared/creation/contracts.js";
import { CreationError } from "./contracts.js";

export function creationOutputType(value: unknown): CreationRequestedOutput {
  if (value === "auto" || CREATION_OUTPUT_TYPES.some((kind) => kind === value)) return value as CreationRequestedOutput;
  throw new CreationError("invalidInput");
}
export function assertCreationOutput(task: { kind: CreationRequestedOutput }, kind: string) {
  if (!CREATION_OUTPUT_TYPES.some((value) => value === kind) || (task.kind !== "auto" && task.kind !== kind))
    throw new CreationError("invalidOutput");
}
