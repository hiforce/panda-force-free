import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeSkillCapture } from "../../../shared/skills/capture-codec.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { CreationError, type CreationTaskSpec } from "../contracts.js";
import type { CreationInputs, CreationInputSnapshot } from "../input.js";
import {
  creationAssetArtifact,
  creationDigest,
  creationId,
  creationRecord,
  creationText,
  creationUuid,
} from "../validation.js";
import { creationRunInput } from "../run-input.js";
import { richDocumentInput } from "../../documents/rich-codec.js";

import { creationOutputType } from "../output-type.js";
import { creationEngineProfile, creationPrompt } from "../input-values.js";
export { creationEngineProfile, creationPrompt } from "../input-values.js";

function snapshot(value: unknown): CreationInputSnapshot {
  const row = creationRecord(value, [
      "schema",
      "taskId",
      "owner",
      "projectId",
      "requestDigest",
      "prompt",
      "outputType",
      "dialogue",
      "discussion",
      "documentFileLineage",
      "profile",
      "skills",
      "previous",
      "previousAsset",
      "materials",
      "recoveryFrom",
    ]),
    outputType = row.outputType === undefined ? undefined : creationOutputType(row.outputType),
    skills = decodeSkillCapture(row.skills),
    taskId = creationUuid(row.taskId),
    owner = creationText(row.owner, 200),
    requestDigest = creationDigest(row.requestDigest);
  if (
    row.schema !== 1 ||
    (row.dialogue !== undefined && row.dialogue !== true) ||
    (row.discussion !== undefined && (!Array.isArray(row.discussion) || row.discussion.length > 5)) ||
    skills.id !== taskId ||
    skills.owner !== owner ||
    skills.requestBinding !== requestDigest ||
    (outputType !== undefined && skills.composition.mode !== "guidance") ||
    (skills.composition.mode === "guidance"
      ? outputType === undefined || skills.composition.outputType !== (outputType === "auto" ? "document" : outputType)
      : skills.composition.outputType !== "document" ||
        !skills.composition.capabilities.includes("project.documents.create"))
  )
    throw new CreationError("invalidInput");
  return {
    schema: 1,
    taskId,
    owner,
    projectId: creationId(row.projectId),
    requestDigest,
    prompt: creationPrompt(row.prompt),
    ...(outputType === undefined ? {} : { outputType }),
    ...(row.dialogue === true ? { dialogue: true as const } : {}),
    ...(Array.isArray(row.discussion)
      ? {
          discussion: row.discussion.map((entry) => {
            const turn = creationRecord(entry, ["user", "assistant"]);
            const user = creationPrompt(turn.user);
            if (user.length > 6000) throw new CreationError("invalidInput");
            return { user, assistant: creationText(turn.assistant, 6000) };
          }),
        }
      : {}),
    ...(row.documentFileLineage === undefined ? {} : { documentFileLineage: creationUuid(row.documentFileLineage) }),
    profile: creationEngineProfile(row.profile),
    skills,
    ...(row.materials === undefined ? {} : { materials: decodeCreationMaterials(row.materials) }),
    ...(row.previous === undefined ? {} : { previous: previousInput(row.previous) }),
    ...(row.previousAsset === undefined ? {} : { previousAsset: previousAssetInput(row.previousAsset) }),
    ...(row.recoveryFrom === undefined ? {} : { recoveryFrom: recoveryInput(row.recoveryFrom) }),
  };
}
function previousAssetInput(value: unknown): NonNullable<CreationInputSnapshot["previousAsset"]> {
  const row = creationRecord(value, ["taskId", "prompt", "artifact"]),
    artifact = creationRecord(row.artifact, [
      "kind",
      "projectId",
      "assetId",
      "operationId",
      "version",
      "commit",
      "title",
      "source",
    ]);
  return {
    taskId: creationUuid(row.taskId),
    prompt: creationPrompt(row.prompt),
    artifact: creationAssetArtifact(artifact, {
      kind: "auto",
      projectId: creationId(artifact.projectId),
      operationId: creationUuid(artifact.operationId),
    }),
  };
}
function recoveryInput(value: unknown) {
  const row = creationRecord(value, ["taskId", "inputDigest"]);
  return { taskId: creationUuid(row.taskId), inputDigest: creationDigest(row.inputDigest) };
}
export function decodeCreationMaterials(value: unknown) {
  if (!Array.isArray(value) || value.length > 10) throw new CreationError("invalidInput");
  return value.map((entry): import("../../../shared/creation/contracts.js").CreationMaterial => {
    const material = creationRecord(entry, ["id", "name", "kind", "digest"]);
    if (material.kind !== "file" && material.kind !== "image") throw new CreationError("invalidInput");
    return {
      id: creationUuid(material.id),
      name: creationText(material.name, 240),
      kind: material.kind,
      digest: creationDigest(material.digest),
    };
  });
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
  if (Buffer.byteLength(stableJson(result)) > 4 * 1024 * 1024) throw new CreationError("invalidInput");
  return result;
}
const digest = (value: CreationInputSnapshot) => createHash("sha256").update(stableJson(value)).digest("hex");
/** Prompts, ordered instructions and parameters are immutable files; the task ledger stores only their digest. */
export class FileCreationInputs implements CreationInputs {
  private readonly files: FilePackageContent<CreationInputSnapshot>;
  constructor(root: string) {
    this.files = new FilePackageContent(root, {
      maxBytes: 6 * 1024 * 1024,
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
      (value.outputType ?? "document") !== task.kind ||
      value.skills.id !== task.skillCaptureId
    )
      throw new CreationError("unavailable");
    return value;
  }
}
