import type { DocumentCheckpointResult } from "../../shared/documents/working-copy.js";
import { stableJson } from "../../shared/stable-json.js";
import { fileDigest, fileInteger } from "./codec-values.js";
import type { ProjectContentCoordinator } from "./coordinator.js";
import { decodeProjectDocument } from "./document-file.js";
import { revisionCommitMessage } from "./document-history.js";
import type { ProjectDocumentFiles } from "./document-store.js";
import { assertCheckpointContent } from "./drafts/checkpoint-policy.js";
import { currentDraftContent, draftContent, type ProjectDraftContent } from "./drafts/content.js";
import { assertDocumentWritable, readSavedDocument } from "./drafts/current.js";
import type { ProjectDocumentDrafts } from "./drafts/store.js";
import { ProjectContentError } from "./errors.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import type { ContentMutationJournal } from "./journal.js";
import { contentRequestHash } from "./mutation.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId, projectDocumentFile } from "./paths.js";
import { nextSourceRevision } from "./source-revision.js";

export interface ProjectSourceEditCommand {
  operationId: string;
  documentId: string;
  expectedRevisionId: string;
  expectedVersion: number;
  expectedContentHash: string;
  intentHash: string;
  content: ProjectDraftContent;
  author: ContentAuthor;
}

/** Saved-source changes own their Git receipt. They never replace an unsaved draft or rely on a task database transaction. */
export class ProjectDocumentSourceEdits {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
    private readonly documents: ProjectDocumentFiles,
    private readonly drafts: ProjectDocumentDrafts,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }

  private command(input: ProjectSourceEditCommand) {
    const documentId = projectContentId(input.documentId),
      content = draftContent(input.content),
      expectedRevisionId = projectContentId(input.expectedRevisionId),
      expectedVersion = fileInteger(input.expectedVersion, 1),
      expectedContentHash = fileDigest(input.expectedContentHash);
    return {
      documentId,
      content,
      expectedRevisionId,
      expectedVersion,
      expectedContentHash,
      mutation: {
        operationId: projectContentId(input.operationId),
        author: input.author,
        message: "Apply saved project document edit",
        intent: stableJson({
          schema: 1,
          kind: "saved-source-edit",
          projectId: this.owned.projectId,
          documentId,
          expectedRevisionId,
          expectedVersion,
          expectedContentHash,
          intentHash: fileDigest(input.intentHash),
          contentHash: contentRequestHash(content),
        }),
      },
    };
  }
  private async result(documentId: string, receipt: ContentMutationJournal): Promise<DocumentCheckpointResult> {
    const bytes = await this.snapshots.fileAt(receipt.commit, projectDocumentFile(documentId));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const detail = decodeProjectDocument(bytes);
    if (detail.document.id !== documentId) throw new ProjectContentError("invalidFile");
    return { detail, commit: receipt.commit, changed: receipt.changes.length > 0 };
  }
  async receipt(input: ProjectSourceEditCommand): Promise<DocumentCheckpointResult | null> {
    const command = this.command(input),
      receipt = await this.coordinator.plannedReceipt(command.mutation);
    return receipt === null ? null : this.result(command.documentId, receipt);
  }
  async apply(input: ProjectSourceEditCommand): Promise<DocumentCheckpointResult> {
    const command = this.command(input),
      { documentId, content } = command;
    const receipt = await this.coordinator.plan(command.mutation, async (view) => {
      const current = await readSavedDocument(view, this.owned.projectId, documentId),
        draft = await this.drafts.snapshot(view, current);
      await assertDocumentWritable(view, this.owned.projectId, documentId);
      if (
        current.revision.id !== command.expectedRevisionId ||
        current.document.revision !== command.expectedVersion ||
        current.document.contentHash !== command.expectedContentHash
      )
        throw new ProjectContentError("conflict");
      if (draft.dirty || draft.stale) throw new ProjectContentError("workingCopyChanged");
      await assertCheckpointContent(view, this.owned.projectId, documentId, current.document.spaceId, content);
      if (stableJson(content) === stableJson(currentDraftContent(current))) return { changes: [] };
      const detail = nextSourceRevision(current, content);
      return {
        changes: await this.documents.prepare(view, detail, current.document.revision),
        message:
          revisionCommitMessage(detail.revision) +
          "\nPanda-Checkpoint: source-edit\nPanda-Draft-Version: " +
          draft.version +
          "\nPanda-Source-Revision: " +
          current.revision.id,
      };
    });
    return this.result(documentId, receipt);
  }
}
