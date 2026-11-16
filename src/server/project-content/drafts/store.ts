import { stableJson } from "../../../shared/stable-json.js";
import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import type { DocumentWorkingState } from "../../../shared/documents/working-copy.js";
import { fileInteger, fileText } from "../codec-values.js";
import type { ProjectContentCoordinator } from "../coordinator.js";
import { ProjectContentError } from "../errors.js";
import { contentRequestHash } from "../mutation.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import { projectContentId } from "../paths.js";
import type { ProjectContentView } from "../read-view.js";
import { draftContent, type ProjectDraftContent } from "./content.js";
import { assertDocumentWritable, readSavedDocument } from "./current.js";
import { encodeDraftFile, type ProjectDraftFile, type ProjectDraftFrame, type ProjectDraftReceipt } from "./file.js";
import { ProjectDraftWorkingFiles } from "./working-files.js";
import { ProjectDraftConsumption } from "./consumed.js";

export interface ProjectDraftCommand {
  documentId: string;
  expectedVersion: number;
  baseRevisionId: string;
  operationId: string;
  actor: string;
}
export interface ProjectDocumentDraftState extends DocumentWorkingState {
  content: ProjectDraftContent | null;
}

/** Autosave acknowledges a durable working generation; it never creates a saved revision or changes the Git head. */
export class ProjectDocumentDrafts {
  private readonly files: ProjectDraftWorkingFiles;
  private readonly consumption: ProjectDraftConsumption;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.files = new ProjectDraftWorkingFiles(owned);
    this.consumption = new ProjectDraftConsumption(owned);
  }
  async snapshot(view: ProjectContentView, current: DocumentDetail): Promise<ProjectDocumentDraftState> {
    const { file } = await this.files.record(view, current.document.id);
    if (file && file.spaceId !== current.document.spaceId) throw new ProjectContentError("invalidFile");
    const content = await this.consumption.working(view, current, file),
      dirty = content !== null;
    return {
      version: file?.version ?? 0,
      savedRevisionId: current.revision.id,
      baseRevisionId: dirty ? file!.baseRevisionId : current.revision.id,
      content,
      dirty,
      stale: dirty && file!.baseRevisionId !== current.revision.id,
      updatedAt: file?.updatedAt ?? current.document.updatedAt,
    };
  }
  async get(documentId: string) {
    projectContentId(documentId);
    return this.coordinator.view(async (view) =>
      this.snapshot(view, await readSavedDocument(view, this.owned.projectId, documentId)),
    );
  }
  async put(input: ProjectDraftCommand & { content: ProjectDraftContent }) {
    return this.change(input, draftContent(input.content), "autosave");
  }
  async discard(input: ProjectDraftCommand) {
    return this.change(input, null, "discard");
  }
  private async change(
    input: ProjectDraftCommand,
    content: ProjectDraftContent | null,
    kind: ProjectDraftReceipt["kind"],
  ): Promise<ProjectDraftReceipt> {
    const command: ProjectDraftCommand = {
        documentId: projectContentId(input.documentId),
        expectedVersion: fileInteger(input.expectedVersion),
        baseRevisionId: projectContentId(input.baseRevisionId),
        operationId: projectContentId(input.operationId),
        actor: fileText(input.actor, 800),
      },
      requestHash = contentRequestHash({
        schema: 1,
        projectId: this.owned.projectId,
        kind,
        ...command,
        contentHash: contentRequestHash(content),
      });
    return this.coordinator.view(async (view) => {
      const receipt = await this.files.receipt(view, command.operationId);
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new ProjectContentError("conflict");
        return receipt;
      }
      const current = await readSavedDocument(view, this.owned.projectId, command.documentId),
        record = await this.files.record(view, command.documentId),
        file = record.file;
      if (file?.lastOperation.operationId === command.operationId) {
        if (file.lastOperation.requestHash !== requestHash) throw new ProjectContentError("conflict");
        return file.lastOperation;
      }
      await assertDocumentWritable(view, this.owned.projectId, command.documentId);
      if (current.revision.id !== command.baseRevisionId || (file?.version ?? 0) !== command.expectedVersion)
        throw new ProjectContentError("conflict");
      if (file && file.spaceId !== current.document.spaceId) throw new ProjectContentError("invalidFile");
      const active = await this.consumption.working(view, current, file);
      if (kind === "autosave" && active && file!.baseRevisionId !== current.revision.id)
        throw new ProjectContentError("conflict");
      if (content && (active ?? current.revision).body && content.body === undefined)
        throw new ProjectContentError("conflict");
      const changed =
          !file || file.baseRevisionId !== command.baseRevisionId || stableJson(file.content) !== stableJson(content),
        frame: ProjectDraftFrame = {
          schema: 1,
          projectId: this.owned.projectId,
          documentId: command.documentId,
          spaceId: current.document.spaceId,
          version: (file?.version ?? 0) + (changed ? 1 : 0),
          baseRevisionId: command.baseRevisionId,
          content,
          updatedAt: changed ? Math.max(Date.now(), file?.updatedAt ?? 0) : file!.updatedAt,
        },
        result: ProjectDraftReceipt = {
          schema: 1,
          operationId: command.operationId,
          documentId: command.documentId,
          baseRevisionId: command.baseRevisionId,
          actor: command.actor,
          kind,
          version: frame.version,
          projectId: this.owned.projectId,
          stateHash: contentRequestHash(frame),
          requestHash,
          updatedAt: frame.updatedAt,
        };
      // The receipt deliberately excludes source bodies; the latest durable frame repairs a missing receipt after a crash.
      const value: ProjectDraftFile = { ...frame, lastOperation: result };
      await this.files.replace(view, command.documentId, record.bytes, encodeDraftFile(value));
      await this.files.writeReceipt(view, result);
      return result;
    });
  }
}
