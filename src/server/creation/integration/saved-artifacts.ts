import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import type { CreationArtifactWriter } from "../ports.js";
import type { CreationTaskSpec } from "../contracts.js";
import { CreationError } from "../contracts.js";
import {
  creationArtifact,
  creationDigest,
  creationRecord,
  creationTaskSpec,
  creationText,
  creationUuid,
} from "../validation.js";
interface SavedArtifact {
  schema: 1;
  task: CreationTaskSpec;
  outputDigest: string;
  artifact: import("../../../shared/creation/contracts.js").CreationArtifact;
}
const key = (owner: string, id: string) =>
  createHash("sha256")
    .update(stableJson({ purpose: "creation-saved-primary", owner: creationText(owner, 200), id: creationUuid(id) }))
    .digest("hex");
function decode(value: unknown): SavedArtifact {
  const v = creationRecord(value, ["schema", "task", "outputDigest", "artifact"]),
    task = creationTaskSpec(v.task);
  if (v.schema !== 1) throw new CreationError("invalidInput");
  return {
    schema: 1,
    task,
    outputDigest: creationDigest(v.outputDigest),
    artifact: creationArtifact(v.artifact, task),
  };
}
/** The primary saved receipt remains immutable even when a subsequent ownership or file move needs recovery. */
export class CreationSavedArtifacts implements CreationArtifactWriter {
  private readonly files: FilePackageContent<SavedArtifact>;
  private readonly pending = new Map<string, { signature: string; work: Promise<SavedArtifact["artifact"]> }>();
  constructor(
    root: string,
    private readonly writer: CreationArtifactWriter,
    private readonly authorize: (owner: string, project: string) => Promise<void>,
  ) {
    this.files = new FilePackageContent(root, {
      maxBytes: 16384,
      encode: async (v) => Buffer.from(stableJson(decode(v))),
      decode: async (bytes) => decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (v) => key(v.task.owner, v.task.id),
    });
  }
  private async saved(owner: string, id: string) {
    try {
      return await this.files.read(key(owner, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async read(owner: string, id: string) {
    const saved = await this.saved(owner, id);
    if (!saved) return null;
    if (saved.task.owner !== owner || saved.task.id !== id) throw new CreationError("notFound");
    await this.authorize(owner, saved.task.projectId);
    return structuredClone(saved.artifact);
  }
  async commit(input: CreationTaskSpec, output: string) {
    const task = creationTaskSpec(input),
      outputDigest = creationDigest(output),
      identity = key(task.owner, task.id),
      signature = stableJson({ task, outputDigest });
    await this.authorize(task.owner, task.projectId);
    const running = this.pending.get(identity);
    if (running) {
      if (running.signature !== signature) throw new CreationError("conflict");
      const artifact = await running.work;
      await this.authorize(task.owner, task.projectId);
      return structuredClone(artifact);
    }
    const work = this.write(task, outputDigest, signature).finally(() => this.pending.delete(identity));
    this.pending.set(identity, { signature, work });
    return work;
  }
  private async write(task: CreationTaskSpec, outputDigest: string, signature: string) {
    let saved = await this.saved(task.owner, task.id);
    if (saved) {
      if (stableJson({ task: saved.task, outputDigest: saved.outputDigest }) !== signature)
        throw new CreationError("conflict");
    } else {
      const artifact = creationArtifact(await this.writer.commit(structuredClone(task), outputDigest), task);
      await this.files.put({ schema: 1, task, outputDigest, artifact });
      saved = await this.files.read(key(task.owner, task.id));
      if (
        stableJson({ task: saved.task, outputDigest: saved.outputDigest }) !== signature ||
        stableJson(saved.artifact) !== stableJson(artifact)
      )
        throw new CreationError("conflict");
    }
    await this.authorize(task.owner, task.projectId);
    return structuredClone(saved.artifact);
  }
}
