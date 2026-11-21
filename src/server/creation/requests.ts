import { createHash } from "node:crypto";
import { stableJson } from "../../shared/stable-json.js";
import { SKILL_LIMITS } from "../../shared/skills/contracts.js";
import type { CreationRequest } from "./input.js";
import { creationOutputType } from "./output-type.js";
import { CreationError } from "./contracts.js";
import {
  creationDigest,
  creationId,
  creationInteger,
  creationRecord,
  creationText,
  creationUuid,
  creationUuidFromDigest,
} from "./validation.js";

export const creationRequestDigest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
function parameters(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreationError("invalidInput");
  const row = creationRecord(value, Object.keys(value)),
    result: Record<string, string | number | boolean> = {};
  if (Object.keys(row).length > 32) throw new CreationError("invalidInput");
  for (const [key, value] of Object.entries(row)) {
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) ||
      key.length > 64 ||
      !(
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 4000)
      )
    )
      throw new CreationError("invalidInput");
    result[key] = value;
  }
  return result;
}
export function creationRequest(value: unknown): CreationRequest {
  const row = creationRecord(value, [
      "id",
      "projectId",
      "treeVersion",
      "parentId",
      "locale",
      "prompt",
      "profileId",
      "selections",
      "previousTaskId",
      "runtimeId",
      "model",
      "effort",
      "attachments",
      "outputType",
    ]),
    locale = creationText(row.locale, 35),
    prompt = row.prompt;
  if (
    !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale) ||
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt) > 65536 ||
    !Array.isArray(row.selections) ||
    row.selections.length > SKILL_LIMITS.selections
  )
    throw new CreationError("invalidInput");
  return {
    id: creationUuid(row.id),
    projectId: creationId(row.projectId),
    treeVersion: creationInteger(row.treeVersion),
    parentId: row.parentId === null ? null : creationId(row.parentId),
    locale,
    prompt,
    profileId: creationId(row.profileId),
    ...(row.outputType === undefined ? {} : { outputType: creationOutputType(row.outputType) }),
    ...(row.runtimeId === undefined ? {} : { runtimeId: creationId(row.runtimeId) }),
    ...(row.model === undefined || row.model === "" ? {} : { model: creationText(row.model, 128) }),
    ...(row.effort === undefined || row.effort === "" ? {} : { effort: creationText(row.effort, 64) }),
    ...(row.attachments === undefined ? {} : { attachments: creationAttachments(row.attachments) }),
    ...(row.previousTaskId === undefined ? {} : { previousTaskId: creationUuid(row.previousTaskId) }),
    selections: row.selections.map((value) => {
      const skill = creationRecord(value, ["packageId", "version", "digest", "id", "parameters"]);
      return {
        packageId: creationText(skill.packageId, 96),
        version: creationText(skill.version, 20),
        digest: creationDigest(skill.digest),
        id: creationId(skill.id),
        parameters: parameters(skill.parameters),
      };
    }),
  };
}
export function creationAttachments(value: unknown) {
  if (!Array.isArray(value) || value.length > 10) throw new CreationError("invalidInput");
  const refs = value.map((entry) => ({ materialId: creationUuid(creationRecord(entry, ["materialId"]).materialId) }));
  if (new Set(refs.map((ref) => ref.materialId)).size !== refs.length) throw new CreationError("invalidInput");
  return refs;
}
/** A task slot is stable across concurrent submissions, independent of model-chosen call IDs. */
export function creationOperation(owner: string, id: string): string {
  const hex = creationRequestDigest({ namespace: "panda-document-creation", owner, id });
  return creationUuidFromDigest(hex);
}
