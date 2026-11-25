import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeSkillCapture } from "../../../shared/skills/capture-codec.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { creationRecord, creationText, creationUuid, creationDigest } from "../validation.js";
import { CreationError } from "../contracts.js";
import { creationEngineProfile, creationPrompt, decodeCreationMaterials } from "./input-codec.js";
import type { CreationMessagePayload, CreationMessageFiles } from "../messages/contracts.js";
function payload(value: unknown): CreationMessagePayload {
  const row = creationRecord(value, [
    "schema",
    "id",
    "owner",
    "taskId",
    "requestDigest",
    "prompt",
    "profile",
    "skills",
    "inheritSkills",
    "materials",
  ]);
  if (row.schema !== 1 || (row.inheritSkills !== undefined && (row.inheritSkills !== true || row.skills !== null)))
    throw new CreationError("invalidInput");
  const result: CreationMessagePayload = {
    schema: 1,
    id: creationUuid(row.id),
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    requestDigest: creationDigest(row.requestDigest),
    prompt: creationPrompt(row.prompt),
    profile: creationEngineProfile(row.profile),
    ...(row.inheritSkills === true ? { inheritSkills: true } : {}),
    skills: row.skills === null ? null : decodeSkillCapture(row.skills, { workflowRequired: false }),
    materials: decodeCreationMaterials(row.materials),
  };
  if (
    result.skills &&
    (result.skills.id !== result.id ||
      result.skills.owner !== result.owner ||
      result.skills.requestBinding !== result.requestDigest)
  )
    throw new CreationError("invalidInput");
  return result;
}
const hash = (value: CreationMessagePayload) => createHash("sha256").update(stableJson(value)).digest("hex");
export class FileCreationMessages implements CreationMessageFiles {
  private readonly files: FilePackageContent<CreationMessagePayload>;
  constructor(root: string) {
    this.files = new FilePackageContent(root, {
      maxBytes: 2 * 1024 * 1024,
      encode: async (value) => Buffer.from(stableJson(payload(value))),
      decode: async (bytes) => payload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: hash,
    });
  }
  async put(value: CreationMessagePayload) {
    const frozen = payload(value);
    await this.files.put(frozen);
    return hash(frozen);
  }
  read(digest: string) {
    return this.files.read(digest);
  }
}
