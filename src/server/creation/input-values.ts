import type { CreationEngineProfile } from "./input.js";
import { CreationError } from "./contracts.js";
import { creationId, creationRecord, creationText } from "./validation.js";

export function creationEngineProfile(value: unknown): CreationEngineProfile {
  const row = creationRecord(value, ["id", "engineId", "runtimeId", "model", "effort", "media"]);
  const media = row.media === undefined ? undefined : creationRecord(row.media, ["model", "effort"]);
  return {
    ...(media
      ? {
          media: {
            model: creationText(media.model, 128),
            ...(media.effort ? { effort: creationText(media.effort, 64) } : {}),
          },
        }
      : {}),
    id: creationId(row.id),
    engineId: creationId(row.engineId),
    ...(row.runtimeId === undefined ? {} : { runtimeId: creationId(row.runtimeId) }),
    ...(row.model === undefined ? {} : { model: creationText(row.model, 128) }),
    ...(row.effort === undefined ? {} : { effort: creationText(row.effort, 64) }),
  };
}
export function creationPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 65536)
    throw new CreationError("invalidInput");
  return value;
}
