import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { decodeProjectDocument } from "../document-file.js";
import { ProjectContentError } from "../errors.js";
import { readContentHistory } from "../git/history.js";
import { ProjectGitSnapshots } from "../git/snapshot.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import { projectDocumentFile } from "../paths.js";
import type { ProjectContentView } from "../read-view.js";
import { currentDraftContent, type ProjectDraftContent } from "./content.js";
import type { ProjectDraftFile } from "./file.js";

/** A saved generation stays consumed after later renames or source changes; its old working bytes cannot reappear as new edits. */
export class ProjectDraftConsumption {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(private readonly owned: OwnedProjectDirectory) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }
  async working(
    view: ProjectContentView,
    current: DocumentDetail,
    file: ProjectDraftFile | null,
  ): Promise<ProjectDraftContent | null> {
    if (!file?.content || stableJson(file.content) === stableJson(currentDraftContent(current))) return null;
    if (file.baseRevisionId === current.revision.id) return file.content;
    const path = projectDocumentFile(current.document.id),
      rows = await readContentHistory(this.owned, {
        path,
        commit: view.commit,
        limit: 2,
        patterns: [
          "^Panda-Document: " + current.document.id + "$",
          "^Panda-Checkpoint: save$",
          "^Panda-Draft-Version: " + file.version + "$",
          "^Panda-Source-Revision: " + file.baseRevisionId + "$",
        ],
      });
    if (!rows.length) return this.beforeSourceEdit(view, current, file);
    if (rows.length !== 1) throw new ProjectContentError("invalidFile");
    const bytes = await this.snapshots.fileAt(rows[0]!.commit, path);
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const saved = decodeProjectDocument(bytes);
    if (
      saved.document.id !== current.document.id ||
      saved.document.spaceId !== current.document.spaceId ||
      stableJson(currentDraftContent(saved)) !== stableJson(file.content)
    )
      throw new ProjectContentError("invalidFile");
    return null;
  }

  /** A clean working frame may equal the old source without ever having gone through an explicit save. */
  private async beforeSourceEdit(view: ProjectContentView, current: DocumentDetail, file: ProjectDraftFile) {
    const path = projectDocumentFile(current.document.id),
      rows = await readContentHistory(this.owned, {
        path,
        commit: view.commit,
        limit: 2,
        patterns: [
          "^Panda-Document: " + current.document.id + "$",
          "^Panda-Checkpoint: source-edit$",
          "^Panda-Draft-Version: " + file.version + "$",
          "^Panda-Source-Revision: " + file.baseRevisionId + "$",
        ],
      });
    if (!rows.length) return file.content;
    if (rows.length !== 1) throw new ProjectContentError("invalidFile");
    const parent = await this.snapshots.parent(rows[0]!.commit),
      previousBytes = await this.snapshots.fileAt(parent, path),
      appliedBytes = await this.snapshots.fileAt(rows[0]!.commit, path);
    if (previousBytes === null || appliedBytes === null) throw new ProjectContentError("invalidFile");
    const previous = decodeProjectDocument(previousBytes),
      applied = decodeProjectDocument(appliedBytes);
    if (
      previous.document.id !== current.document.id ||
      applied.document.id !== current.document.id ||
      previous.document.spaceId !== current.document.spaceId ||
      applied.document.spaceId !== current.document.spaceId ||
      previous.revision.id !== file.baseRevisionId ||
      applied.revision.number !== previous.revision.number + 1 ||
      stableJson(currentDraftContent(previous)) !== stableJson(file.content)
    )
      throw new ProjectContentError("invalidFile");
    return null;
  }
}
