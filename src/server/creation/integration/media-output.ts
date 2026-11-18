import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import type { FileCreativeAssets } from "../../creative/assets/service.js";
import type { CreationArtifactWriter, CreationOutputContent } from "../ports.js";
import { CreationError, CreationWriteError, type CreationTaskSpec } from "../contracts.js";
import { assertCreationOutput } from "../output-type.js";
import { creationDigest, creationRecord, creationText, creationUuid } from "../validation.js";
import type { ImageRenderJournal } from "./rendering/image-journal.js";
import { DocumentError } from "../../documents/errors.js";
import type { CreationGeneratedOriginals, GeneratedKind } from "./rendering/generated-originals.js";
import { creativeSaveInput, validateCreativeOriginal } from "../../creative/assets/prepare.js";
import { creationArtifactSaveSlots } from "./rendering/slots.js";

export type CreationAssetAccess = (
  owner: string,
  project: string,
) => Promise<Pick<FileCreativeAssets, "save" | "original">>;
interface MediaOutput {
  owner: string;
  taskId: string;
  kind: "image" | GeneratedKind;
  title: string;
  handle: string;
}
function output(value: unknown): MediaOutput {
  const row = creationRecord(value, ["owner", "taskId", "kind", "title", "handle"]),
    title = creationText(row.title, 200).trim();
  if (!["image", "slides", "web", "video"].includes(String(row.kind)) || !title)
    throw new CreationError("invalidOutput");
  return {
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    kind: row.kind as MediaOutput["kind"],
    title,
    handle: creationDigest(row.handle),
  };
}
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
/** Only durable render handles from this owner and task can become immutable project originals. */
export class FileCreationMediaOutput implements CreationOutputContent, CreationArtifactWriter {
  private readonly files: FilePackageContent<MediaOutput>;
  constructor(
    root: string,
    private readonly images: ImageRenderJournal,
    private readonly assets: CreationAssetAccess,
    private readonly generated?: CreationGeneratedOriginals,
  ) {
    this.files = new FilePackageContent<MediaOutput>(root, {
      maxBytes: 4096,
      encode: async (v) => Buffer.from(stableJson(output(v))),
      decode: async (b) => output(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b))),
      digest: hash,
    });
  }
  async stage(value: unknown, task?: CreationTaskSpec) {
    return creationArtifactSaveSlots.run(new AbortController().signal, async () => {
      if (!task) throw new CreationError("invalidInput");
      const saved = output(value);
      this.check(task, saved);
      await validateCreativeOriginal(await this.prepared(task, saved));
      await this.files.put(saved);
      return hash(saved);
    });
  }
  async commit(task: CreationTaskSpec, digest: string) {
    return creationArtifactSaveSlots.run(new AbortController().signal, async () => {
      try {
        const saved = await this.files.read(digest);
        this.check(task, saved);
        const prepared = await this.prepared(task, saved),
          assets = await this.assets(task.owner, task.projectId),
          result = await assets.save(task.owner, task.projectId, prepared);
        return {
          kind: saved.kind,
          projectId: task.projectId,
          assetId: result.asset.id,
          operationId: task.operationId,
          version: result.asset.version,
          commit: result.commit,
          title: result.asset.title,
          source: result.asset.source,
        };
      } catch (error) {
        if (error instanceof CreationError && error.code === "invalidOutput") throw error;
        throw new CreationWriteError(
          error instanceof DocumentError && ["notFound", "conflict"].includes(error.code)
            ? "targetChanged"
            : "writeUnavailable",
          error,
        );
      }
    });
  }
  private check(task: CreationTaskSpec, value: MediaOutput) {
    assertCreationOutput(task, value.kind);
    if (value.owner !== task.owner || value.taskId !== task.id) throw new CreationError("invalidOutput");
  }
  private async prepared(task: CreationTaskSpec, saved: MediaOutput) {
    let original: { name: string; bytes: Uint8Array; resources?: { name: string; bytes: Uint8Array }[] };
    if (saved.kind === "image") {
      const { receipt } = await this.images.resolve(task.owner, task.id, saved.handle),
        extension = receipt.mime === "image/jpeg" ? "jpg" : receipt.mime === "image/webp" ? "webp" : "png";
      original = { name: "image-" + task.id + "." + extension, bytes: receipt.bytes };
    } else {
      if (!this.generated) throw new CreationError("unavailable");
      const rendered = await this.generated.resolve(task.owner, task.id, saved.kind, saved.handle);
      original = { name: rendered.source.name, bytes: rendered.bytes, resources: rendered.resources };
    }
    return creativeSaveInput({
      id: "c-" + task.operationId,
      operationId: task.operationId,
      expectedVersion: null,
      kind: saved.kind,
      title: saved.title,
      locale: task.target.locale,
      ...original,
    });
  }
}
