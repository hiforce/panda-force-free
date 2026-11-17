import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import type { RichDocumentBody } from "../../../shared/documents/rich-body.js";
import { FilePackageContent, type PackageContentCodec } from "../../packages/content-store.js";
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { CreationInputs } from "../input.js";
import { richDocumentInput } from "../../documents/rich-codec.js";
import { DocumentError } from "../../documents/errors.js";
import { CreationError, CreationWriteError, type CreationTaskSpec } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import type { CreationArtifactWriter, CreationOutputContent } from "../ports.js";
import { CreationRevisionTargets } from "./revision-targets.js";
import {
  creationArchiveDestination,
  type CreationArchiveDestination,
  type CreationDocumentArchive,
} from "./document-archive.js";

interface DocumentOutput {
  title: string;
  body: RichDocumentBody;
  archiveTo?: CreationArchiveDestination;
  fileDirectory?: string;
}
function documentOutput(value: unknown): DocumentOutput {
  try {
    const input = creationRecord(value, ["title", "body", "archiveTo", "fileDirectory"]),
      title = creationText(input.title, 200).trim(),
      source = richDocumentInput(input.body);
    // Asset ownership needs its own application tool. Model text cannot borrow an existing private asset ID.
    if (!title) throw new CreationError("invalidOutput");
    return {
      title,
      body: source.body,
      ...(input.fileDirectory === undefined ? {} : { fileDirectory: creationText(input.fileDirectory, 4096) }),
      ...(input.archiveTo === undefined ? {} : { archiveTo: creationArchiveDestination(input.archiveTo) }),
    };
  } catch (error) {
    reportDiagnostic("creation-document-validation", error);
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
  private readonly targets: CreationRevisionTargets;
  constructor(
    root: string,
    private readonly documents: Pick<FileDocumentNavigation, "createFromSource"> &
      Partial<Pick<FileDocumentNavigation, "appendFromSource">> & {
        revisions?: import("../ports.js").CreationDocumentRevisions;
      },
    private readonly append = false,
    private readonly inputs?: CreationInputs,
    private readonly tasks?: Pick<import("../ports.js").CreationOutputTasks, "get">,
    private readonly archive?: CreationDocumentArchive,
  ) {
    this.files = new FilePackageContent(root, codec);
    this.targets = new CreationRevisionTargets(root + "-revision-targets");
  }
  async stage(value: unknown, task?: CreationTaskSpec): Promise<string> {
    const output = documentOutput(value);
    if (output.archiveTo) {
      if (!task || !this.archive) throw new CreationError("invalidOutput");
      try {
        await this.archive.authorize(task.owner, output.archiveTo);
      } catch (error) {
        throw new CreationWriteError(
          error instanceof DocumentError && error.code === "notFound" ? "targetChanged" : "writeUnavailable",
          error,
        );
      }
    }
    let target: CreationTaskSpec | undefined;
    try {
      target = task ? await this.targets.resolve(task, this.inputs, this.documents.revisions, this.tasks) : undefined;
    } catch (error) {
      if (error instanceof DocumentError && ["conflict", "workingCopyChanged", "notFound"].includes(error.code))
        throw new CreationWriteError("targetChanged", error);
      throw error;
    }
    await this.validateImages(output, target);
    await this.files.put(output);
    return codec.digest(output);
  }
  read(digest: string) {
    return this.files.read(digest);
  }
  resolveTarget(task: CreationTaskSpec) {
    return this.targets.resolve(task, this.inputs, this.documents.revisions, this.tasks);
  }
  async commit(task: CreationTaskSpec, digest: string) {
    try {
      return await this.save(task, digest);
    } catch (error) {
      throw new CreationWriteError(
        error instanceof DocumentError &&
          ["navigationConflict", "notFound", "conflict", "workingCopyChanged"].includes(error.code)
          ? "targetChanged"
          : "writeUnavailable",
        error,
      );
    }
  }
  private async validateImages(output: DocumentOutput, task?: CreationTaskSpec) {
    const images = richDocumentInput(output.body).images;
    if (!images.length) return;
    if (!task?.target.document || !this.inputs) throw new CreationError("invalidOutput");
    const previous = (await this.inputs.read(task)).previous;
    const allowed = new Set(previous ? richDocumentInput(previous.document.body).images : []);
    if (images.some((id) => !allowed.has(id))) throw new CreationError("invalidOutput");
  }
  private async save(task: CreationTaskSpec, digest: string) {
    task = await this.targets.resolve(task, this.inputs, this.documents.revisions, this.tasks);
    const output = await this.files.read(digest);
    await this.validateImages(output, task);
    if (task.previousTaskId && !task.target.document) throw new DocumentError("conflict", 409);
    if (task.target.document) {
      if (!this.documents.revisions) throw new CreationError("unavailable");
      const title = (await this.inputs?.read(task))?.previous?.document.title;
      const artifact = await this.documents.revisions.save(task, digest, output.body);
      return title ? { ...artifact, title } : artifact;
    }
    const write = this.append
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
      title: output.title,
    };
  }
}
