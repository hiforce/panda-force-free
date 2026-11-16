import type { DocumentDetail, DocumentRevision } from "../../shared/documents/contracts.js";
import { encodeProjectDocument, decodeProjectDocument } from "./document-file.js";
import type { ProjectContentView } from "./read-view.js";
import { assertDocumentTransition, validateDocumentRevision } from "./document-transition.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { ProjectContentError } from "./errors.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import type { ContentAuthor } from "./git/process.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ProjectDocumentHistory, revisionCommitMessage, type ProjectRevisionSummary } from "./document-history.js";
import { selectedProjectRevision } from "./document-selection.js";
import { projectRevisionSummary } from "./document-history.js";
import { stableJson } from "../../shared/stable-json.js";
import { projectContentId, projectDocumentFile, projectDocumentId } from "./paths.js";
import { readProjectDocumentMetadata, type ProjectDocumentMetadata } from "./document-metadata.js";

export interface ProjectDocumentMetadataCursor {
  commit: string;
  after: string;
}

/** File content is authoritative; immutable history and replay results are read only from this project's Git. */
export class ProjectDocumentFiles {
  private readonly coordinator: ProjectContentCoordinator;
  private readonly snapshots: ProjectGitSnapshots;
  private readonly history: ProjectDocumentHistory;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    coordinator = new ProjectContentCoordinator(owned),
  ) {
    this.coordinator = coordinator;
    this.snapshots = new ProjectGitSnapshots(owned);
    this.history = new ProjectDocumentHistory(owned);
  }

  private decode(id: string, bytes: Buffer | null): DocumentDetail {
    if (bytes === null) throw new ProjectContentError("notFound");
    const detail = decodeProjectDocument(bytes);
    if (detail.document.id !== id || detail.revision.documentId !== id) throw new ProjectContentError("invalidFile");
    return detail;
  }

  async get(id: string): Promise<DocumentDetail> {
    const path = projectDocumentFile(id),
      state = await this.coordinator.read([path]);
    return this.decode(id, state.files.get(path) ?? null);
  }

  async metadata(id: string): Promise<ProjectDocumentMetadata> {
    return this.coordinator.view((view) => readProjectDocumentMetadata(view, id));
  }

  /** Paged enumeration is tied to one project commit, avoiding mixed versions during catalog construction. */
  async metadataPage(
    limit = 100,
    cursor?: ProjectDocumentMetadataCursor,
  ): Promise<{
    commit: string;
    documents: ProjectDocumentMetadata[];
    nextCursor: ProjectDocumentMetadataCursor | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProjectContentError("invalidFile");
    if (cursor && (!/^[a-f0-9]{40}$/.test(cursor.commit) || projectDocumentId(cursor.after) === null))
      throw new ProjectContentError("invalidFile");
    return this.coordinator.view(async (view) => {
      if (cursor && cursor.commit !== view.commit) throw new ProjectContentError("conflict");
      const paths = view.paths.filter((path) => projectDocumentId(path) !== null).sort();
      const previous = cursor ? paths.indexOf(cursor.after) : -1;
      if (cursor && previous < 0) throw new ProjectContentError("invalidFile");
      const selected = paths.slice(previous + 1, previous + 1 + limit),
        documents: ProjectDocumentMetadata[] = [];
      for (const path of selected) documents.push(await readProjectDocumentMetadata(view, projectDocumentId(path)!));
      const last = selected.at(-1),
        nextCursor = last && paths.indexOf(last) < paths.length - 1 ? { commit: view.commit, after: last } : null;
      return { commit: view.commit, documents, nextCursor };
    });
  }

  /** The supplied immutable revision preserves imported IDs, timestamps and projections; autosave drafts are a separate port. */
  async put(
    detail: DocumentDetail,
    expectedRevision: number | null,
    operationId: string,
    author: ContentAuthor,
  ): Promise<DocumentDetail> {
    const content = encodeProjectDocument(detail),
      value = decodeProjectDocument(content),
      id = value.document.id,
      path = projectDocumentFile(id);
    projectContentId(operationId);
    validateDocumentRevision(value, expectedRevision);
    const result = await this.coordinator.mutate({
      operationId,
      author,
      message: revisionCommitMessage(value.revision),
      changes: [{ path, content }],
      validateBefore: (originals, view) =>
        assertDocumentTransition(view, originals.get(path) ?? null, value, expectedRevision, this.history),
    });
    return this.decode(id, await this.snapshots.fileAt(result.commit, path));
  }

  /** Compose a saved original with other project changes without opening a second coordinator or write lease. */
  async prepare(view: ProjectContentView, input: DocumentDetail, expectedRevision: number | null) {
    const content = encodeProjectDocument(input),
      value = decodeProjectDocument(content),
      path = projectDocumentFile(value.document.id);
    validateDocumentRevision(value, expectedRevision);
    await assertDocumentTransition(view, await view.read(path), value, expectedRevision, this.history);
    return [{ path, content }];
  }

  selection(
    view: ProjectContentView,
    record: ProjectDocumentMetadata["document"],
    revisionId: string,
    maxBytes?: number,
  ) {
    return selectedProjectRevision(this.owned, view, record, revisionId, maxBytes ?? 32 * 1024 * 1024);
  }

  async revision(id: string, revisionId: string, commit?: string): Promise<DocumentRevision> {
    projectContentId(revisionId);
    const path = projectDocumentFile(id),
      current = this.decode(id, await this.snapshots.fileAt(commit ?? (await this.snapshots.head()), path));
    if (current.revision.id === revisionId) return current.revision;
    for (const { commit: selectedCommit, revision: summary } of await this.history.list(id, revisionId, 2, commit)) {
      const value = this.decode(id, await this.snapshots.fileAt(selectedCommit, path));
      if (value.revision.id === revisionId) {
        if (stableJson(projectRevisionSummary(value.revision)) !== stableJson(summary))
          throw new ProjectContentError("invalidFile");
        return value.revision;
      }
    }
    throw new ProjectContentError("notFound");
  }

  async revisions(id: string, limit = 100, commit?: string): Promise<ProjectRevisionSummary[]> {
    const rows = await this.history.list(id, undefined, limit, commit);
    if (!rows.length) throw new ProjectContentError("notFound");
    return rows.map((row) => row.revision);
  }
}
