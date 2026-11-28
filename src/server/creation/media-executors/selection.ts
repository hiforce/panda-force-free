import type { CreationMediaBinding, CreationMediaChoice } from "../../../shared/creation/media-executors.js";
import { CreationError } from "../contracts.js";
import { creationInteger, creationRecord, creationText, creationUuid } from "../validation.js";

export function mediaChoice(value: unknown): CreationMediaChoice {
  const row = creationRecord(value, ["kind", "source", "executorId", "model"]);
  if (row.kind !== "image" && row.kind !== "video") throw new CreationError("invalidInput");
  if (row.source === "harness" && row.executorId === undefined && row.model === undefined)
    return { kind: row.kind, source: "harness" };
  if (row.source !== "executor") throw new CreationError("invalidInput");
  return {
    kind: row.kind,
    source: "executor",
    executorId: creationUuid(row.executorId),
    ...(row.model === undefined ? {} : { model: creationText(row.model, 128) }),
  };
}

export function mediaBinding(value: unknown): CreationMediaBinding {
  const row = creationRecord(value, [
    "kind",
    "source",
    "executorId",
    "model",
    "preset",
    "presetVersion",
    "revision",
    "credentialRevision",
  ]);
  const choice = mediaChoice({ kind: row.kind, source: row.source, executorId: row.executorId, model: row.model });
  if (choice.source === "harness") {
    if (
      row.preset !== undefined ||
      row.presetVersion !== undefined ||
      row.revision !== undefined ||
      row.credentialRevision !== undefined
    )
      throw new CreationError("invalidInput");
    return choice;
  }
  const revision = creationInteger(row.revision),
    presetVersion = creationInteger(row.presetVersion);
  if (!revision || !presetVersion || !choice.model) throw new CreationError("invalidInput");
  const credentialRevision = row.credentialRevision === undefined ? undefined : creationInteger(row.credentialRevision);
  if (credentialRevision === 0) throw new CreationError("invalidInput");
  return {
    ...choice,
    model: choice.model,
    preset: creationText(row.preset, 64),
    presetVersion,
    revision,
    ...(credentialRevision ? { credentialRevision } : {}),
  };
}

export function requestedMedia(output: string | undefined) {
  if (output === "image" || output === "slides") return "image";
  if (output === "video") return "video";
  return undefined;
}

export function bindingChoice(value: CreationMediaBinding): CreationMediaChoice {
  if (value.source === "harness") return value;
  const { kind, source, executorId, model } = value;
  return { kind, source, executorId, model };
}
