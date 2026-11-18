import type { CreationEngineProfile } from "./input.js";
import { CreationError } from "./contracts.js";
import { creationId, creationRecord, creationText } from "./validation.js";

export function creationEngineProfile(value: unknown): CreationEngineProfile {
  const row = creationRecord(value, ["id", "engineId", "model", "effort"]);
  return {
    id: creationId(row.id),
    engineId: creationId(row.engineId),
    ...(row.model === undefined ? {} : { model: creationText(row.model, 128) }),
    ...(row.effort === undefined ? {} : { effort: creationId(row.effort) }),
  };
}
export function creationPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 65536)
    throw new CreationError("invalidInput");
  return value;
}
