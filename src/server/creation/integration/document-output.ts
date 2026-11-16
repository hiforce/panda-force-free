import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import type { RichDocumentBody } from "../../../shared/documents/rich-body.js";
import { FilePackageContent, type PackageContentCodec } from "../../packages/content-store.js";
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import { richDocumentInput } from "../../documents/rich-codec.js";
import { DocumentError } from "../../documents/errors.js";
import { CreationError, CreationWriteError, type CreationTaskSpec } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import type { CreationArtifactWriter, CreationOutputContent } from "../ports.js";

interface DocumentOutput {
  title: string;
  body: RichDocumentBody;
}
function documentOutput(value: unknown): DocumentOutput {
  try {
    const input = creationRecord(value, ["title", "body"]),
      title = creationText(input.title, 200).trim(),
      source = richDocumentInput(input.body);
    // Asset ownership needs its own application tool. Model text cannot borrow an existing private asset ID.
    if (!title || source.images.length) throw new CreationError("invalidOutput");
    return { title, body: source.body };
  } catch {
    throw new CreationError("invalidOutput");
  }
}
const codec: PackageContentCodec<DocumentOutput> = {
  maxBytes: 3 * 1024 * 1024,
  encode: async (value) => Buffer.from(stableJson(documentOutput(value))),
  decode: async (bytes) => documentOutput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
  digest: (value) => createHash("sha256").update(stableJson(value)).digest("hex"),
};
/** This adapter alone joins generated rich source with document storage; the task domain knows neither Git nor paths. */
export class FileCreationDocumentOutput implements CreationOutputContent, CreationArtifactWriter {
  private readonly files: FilePackageContent<DocumentOutput>;
  constructor(
    root: string,
    private readonly documents: Pick<FileDocumentNavigation, "createFromSource"> &
      Partial<Pick<FileDocumentNavigation, "appendFromSource">>,
    private readonly append = false,
  ) {
    this.files = new FilePackageContent(root, codec);
  }
  async stage(value: unknown): Promise<string> {
    const output = documentOutput(value);
    await this.files.put(output);
    return codec.digest(output);
  }
  async commit(task: CreationTaskSpec, digest: string) {
    try {
      return await this.save(task, digest);
    } catch (error) {
      throw new CreationWriteError(
        error instanceof DocumentError && ["navigationConflict", "notFound", "conflict"].includes(error.code)
          ? "targetChanged"
          : "writeUnavailable",
        error,
      );
    }
  }
  private async save(task: CreationTaskSpec, digest: string) {
    const output = await this.files.read(digest),
      write = this.append
        ? this.documents.appendFromSource?.bind(this.documents)
        : this.documents.createFromSource.bind(this.documents);
    if (!write) throw new CreationError("unavailable");
    const result = await write(
      task.owner,
      {
        id: task.operationId,
        projectId: task.projectId,
        parentId: task.target.parentId,
        ...(this.append ? { minimumTreeVersion: task.target.treeVersion } : { treeVersion: task.target.treeVersion }),
        locale: task.target.locale,
        title: output.title,
      },
      {
        identity: "creation-document:" + digest,
        prepare: async () => ({ body: output.body, images: [] }),
      },
    );
    return {
      kind: "document" as const,
      projectId: task.projectId,
      documentId: result.operation.documentId,
      operationId: result.operation.id,
      treeVersion: result.operation.treeVersion,
    };
  }
}
