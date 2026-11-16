import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeSkillCapture } from "../../../shared/skills/capture-codec.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { CreationError, type CreationTaskSpec } from "../contracts.js";
import type { CreationEngineProfile, CreationInputs, CreationInputSnapshot } from "../input.js";
import { creationDigest, creationId, creationRecord, creationText, creationUuid } from "../validation.js";
import { creationRunInput } from "../run-input.js";
import { richDocumentInput } from "../../documents/rich-codec.js";

export function creationEngineProfile(value: unknown): CreationEngineProfile {
  const row = creationRecord(value, ["id", "engineId", "model"]);
  return {
    id: creationId(row.id),
    engineId: creationId(row.engineId),
    ...(row.model === undefined ? {} : { model: creationText(row.model, 128) }),
  };
}
export function creationPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 65536)
    throw new CreationError("invalidInput");
  return value;
}
function snapshot(value: unknown): CreationInputSnapshot {
  const row = creationRecord(value, [
      "schema",
      "taskId",
      "owner",
      "projectId",
      "requestDigest",
      "prompt",
      "profile",
      "skills",
      "previous",
    ]),
    skills = decodeSkillCapture(row.skills),
    taskId = creationUuid(row.taskId),
    owner = creationText(row.owner, 200),
    requestDigest = creationDigest(row.requestDigest);
  if (
    row.schema !== 1 ||
    skills.id !== taskId ||
    skills.owner !== owner ||
    skills.requestBinding !== requestDigest ||
    skills.composition.outputType !== "document" ||
    !skills.composition.capabilities.includes("project.documents.create")
  )
    throw new CreationError("invalidInput");
  return {
    schema: 1,
    taskId,
    owner,
    projectId: creationId(row.projectId),
    requestDigest,
    prompt: creationPrompt(row.prompt),
    profile: creationEngineProfile(row.profile),
    skills,
    ...(row.previous === undefined ? {} : { previous: previousInput(row.previous) }),
  };
}
function previousInput(value: unknown): NonNullable<CreationInputSnapshot["previous"]> {
  const row = creationRecord(value, ["prompt", "document"]),
    document = creationRecord(row.document, ["title", "body"]);
  const result = {
    prompt: creationPrompt(row.prompt),
    document: {
      title: creationText(document.title, 200),
      body: richDocumentInput(document.body).body,
    },
  };
  if (Buffer.byteLength(stableJson(result)) > 196608) throw new CreationError("invalidInput");
  return result;
}
const digest = (value: CreationInputSnapshot) => createHash("sha256").update(stableJson(value)).digest("hex");
/** Prompts, ordered instructions and parameters are immutable files; the task ledger stores only their digest. */
export class FileCreationInputs implements CreationInputs {
  private readonly files: FilePackageContent<CreationInputSnapshot>;
  constructor(root: string) {
    this.files = new FilePackageContent(root, {
      maxBytes: 2 * 1024 * 1024,
      encode: async (value) => Buffer.from(stableJson(snapshot(value))),
      decode: async (bytes) => snapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest,
    });
  }
  async put(input: CreationInputSnapshot) {
    const value = snapshot(input);
    creationRunInput(value);
    await this.files.put(value);
    return digest(value);
  }
  async read(task: CreationTaskSpec) {
    const value = await this.files.read(task.inputDigest);
    if (
      value.taskId !== task.id ||
      value.owner !== task.owner ||
      value.projectId !== task.projectId ||
      value.skills.id !== task.skillCaptureId
    )
      throw new CreationError("unavailable");
    return value;
  }
}
