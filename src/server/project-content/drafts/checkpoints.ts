import { stableJson } from "../../../shared/stable-json.js";
import { fileInteger } from "../codec-values.js";
import type { ProjectContentCoordinator } from "../coordinator.js";
import { decodeProjectDocument } from "../document-file.js";
import { ProjectDocumentHistory, revisionCommitMessage } from "../document-history.js";
import type { ProjectDocumentFiles } from "../document-store.js";
import { ProjectContentError } from "../errors.js";
import type { ContentAuthor } from "../git/process.js";
import { ProjectGitSnapshots } from "../git/snapshot.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import { projectContentId, projectDocumentFile } from "../paths.js";
import type { ProjectContentView } from "../read-view.js";
import { currentDraftContent } from "./content.js";
import { assertDocumentWritable, readSavedDocument } from "./current.js";
import { assertCheckpointContent } from "./checkpoint-policy.js";
import { nextSourceRevision } from "../source-revision.js";
import type { ProjectDocumentDrafts } from "./store.js";

export interface ProjectCheckpointCommand {
  documentId: string;
  expectedRevisionId: string;
  expectedDraftVersion: number;
  operationId: string;
  author: ContentAuthor;
}

/** Explicit saves and restores create immutable source versions; autosave state is reconciled by source identity after recovery. */
export class ProjectDocumentCheckpoints {
  private readonly snapshots: ProjectGitSnapshots;
  private readonly history: ProjectDocumentHistory;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
    private readonly documents: ProjectDocumentFiles,
    private readonly drafts: ProjectDocumentDrafts,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
    this.history = new ProjectDocumentHistory(owned);
  }
  async save(input: ProjectCheckpointCommand) {
    return this.checkpoint(input);
  }
  async restore(input: ProjectCheckpointCommand & { revisionId: string }) {
    return this.checkpoint(input, projectContentId(input.revisionId));
  }
  private async original(view: ProjectContentView, id: string, revisionId: string) {
    const rows = await this.history.list(id, revisionId, 2, view.commit);
    if (rows.length !== 1) throw new ProjectContentError("notFound");
    const bytes = await this.snapshots.fileAt(rows[0]!.commit, projectDocumentFile(id));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const detail = decodeProjectDocument(bytes);
    if (detail.document.id !== id || detail.revision.id !== revisionId) throw new ProjectContentError("invalidFile");
    return detail;
  }
  private async checkpoint(input: ProjectCheckpointCommand, restoreRevisionId?: string) {
    const documentId = projectContentId(input.documentId),
      expectedRevisionId = projectContentId(input.expectedRevisionId),
      expectedDraftVersion = fileInteger(input.expectedDraftVersion),
      operationId = projectContentId(input.operationId),
      result = await this.coordinator.plan(
        {
          operationId,
          author: input.author,
          message: restoreRevisionId ? "Restore project document checkpoint" : "Save project document checkpoint",
          intent: stableJson({
            schema: 1,
            documentId,
            expectedRevisionId,
            expectedDraftVersion,
            ...(restoreRevisionId ? { restoreRevisionId } : {}),
          }),
        },
        async (view) => {
          const current = await readSavedDocument(view, this.owned.projectId, documentId),
            state = await this.drafts.snapshot(view, current);
          await assertDocumentWritable(view, this.owned.projectId, documentId);
          if (
            current.revision.id !== expectedRevisionId ||
            state.version !== expectedDraftVersion ||
            (!restoreRevisionId && state.stale)
          )
            throw new ProjectContentError("conflict");
          const selected = restoreRevisionId ? await this.original(view, documentId, restoreRevisionId) : null,
            content = selected ? currentDraftContent(selected) : (state.content ?? currentDraftContent(current));
          await assertCheckpointContent(view, this.owned.projectId, documentId, current.document.spaceId, content);
          if (stableJson(content) === stableJson(currentDraftContent(current))) return { changes: [] };
          const detail = nextSourceRevision(current, content);
          return {
            changes: await this.documents.prepare(view, detail, current.document.revision),
            message:
              revisionCommitMessage(detail.revision) +
              "\nPanda-Checkpoint: " +
              (restoreRevisionId ? "restore" : "save") +
              "\nPanda-Draft-Version: " +
              expectedDraftVersion +
              "\nPanda-Source-Revision: " +
              (restoreRevisionId ?? current.revision.id),
          };
        },
      );
    const bytes = await this.snapshots.fileAt(result.commit, projectDocumentFile(documentId));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const detail = decodeProjectDocument(bytes);
    if (detail.document.id !== documentId) throw new ProjectContentError("invalidFile");
    return { detail, commit: result.commit, changed: result.changes.length > 0 };
  }
}
