import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { errorCode } from "../../../shared/errors.js";
import type { CreationTask, CreationTaskSpec } from "../contracts.js";
import type { CreationInputs } from "../input.js";
import type { CreationDocumentRevisions } from "../ports.js";
import { CreationError } from "../contracts.js";
import {
  creationDocumentReference,
  creationDigest,
  creationRecord,
  creationText,
  creationUuid,
} from "../validation.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { DocumentError } from "../../documents/errors.js";

interface RevisionTarget {
  owner: string;
  taskId: string;
  projectId: string;
  inputDigest: string;
  base: NonNullable<CreationTaskSpec["target"]["document"]>;
}
const key = (value: Pick<RevisionTarget, "owner" | "taskId">) =>
  createHash("sha256")
    .update(stableJson([value.owner, value.taskId]))
    .digest("hex");
function decode(value: unknown): RevisionTarget {
  const row = creationRecord(value, ["owner", "taskId", "projectId", "inputDigest", "base"]);
  return {
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    projectId: creationText(row.projectId, 128),
    inputDigest: creationDigest(row.inputDigest),
    base: creationDocumentReference(row.base),
  };
}
/** Old queued continuations can upgrade only from their exact source. The frozen target survives an uncertain save. */
export class CreationRevisionTargets {
  private readonly files: FilePackageContent<RevisionTarget>;
  constructor(root: string) {
    this.files = new FilePackageContent<RevisionTarget>(root, {
      maxBytes: 4096,
      digest: key,
      encode: async (value) => Buffer.from(stableJson(decode(value))),
      decode: async (bytes) => decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    });
  }
  async resolve(
    task: CreationTaskSpec,
    inputs?: CreationInputs,
    revisions?: CreationDocumentRevisions,
    tasks?: { get(owner: string, id: string): CreationTask | Promise<CreationTask> },
  ): Promise<CreationTaskSpec> {
    if (task.target.document || !task.previousTaskId) return task;
    if (!inputs || !revisions || !tasks) throw new CreationError("unavailable");
    const identity = { owner: task.owner, taskId: task.id, projectId: task.projectId, inputDigest: task.inputDigest };
    let target: RevisionTarget;
    try {
      target = await this.files.read(key(identity));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = await tasks.get(task.owner, task.previousTaskId);
      if (parent.spec.projectId !== task.projectId || !parent.artifact) throw new DocumentError("conflict", 409);
      const source = (await inputs.read(task)).previous?.document;
      const current = await revisions.read(task.owner, task.projectId, parent.artifact.documentId);
      if (
        !source ||
        (current.projectId && current.projectId !== task.projectId) ||
        stableJson(source) !== stableJson(current.document)
      )
        throw new DocumentError("conflict", 409);
      await this.files.put({ ...identity, base: current.base });
      target = await this.files.read(key(identity));
    }
    if (target.inputDigest !== identity.inputDigest || target.projectId !== identity.projectId)
      throw new DocumentError("conflict", 409);
    return { ...task, target: { ...task.target, document: target.base } };
  }
}
