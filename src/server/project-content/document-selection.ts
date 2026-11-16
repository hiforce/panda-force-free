import type { DocumentRecord } from "../../shared/documents/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import type { ProjectContentView } from "./read-view.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { ProjectGitError } from "./git/process.js";
import { ProjectDocumentHistory, projectRevisionSummary } from "./document-history.js";
import { decodeProjectDocument } from "./document-file.js";
import { projectDocumentFile } from "./paths.js";
import { ProjectContentError } from "./errors.js";

/** Historical bodies have an aggregate caller budget as well as the repository's per-original cap. */
export async function selectedProjectRevision(
  owned: OwnedProjectDirectory,
  view: ProjectContentView,
  record: DocumentRecord,
  revisionId: string,
  remaining: number,
) {
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > PROJECT_CONTENT_LIMITS.fileBytes)
    throw new ProjectContentError("tooLarge");
  view.assertHeld();
  const path = projectDocumentFile(record.id);
  let bytes: Buffer | null, summary;
  if (record.revisionId === revisionId) {
    const size = await view.inspect(path, (file) => Promise.resolve(file.size));
    if (size > remaining) throw new ProjectContentError("tooLarge");
    bytes = await view.read(path);
  } else {
    const rows = await new ProjectDocumentHistory(owned).list(record.id, revisionId, 2, view.commit);
    if (rows.length !== 1) throw new ProjectContentError("notFound");
    summary = rows[0]!.revision;
    try {
      bytes = await new ProjectGitSnapshots(owned).fileAt(rows[0]!.commit, path, remaining);
    } catch (error) {
      if (error instanceof ProjectGitError && error.code === "tooLarge") throw new ProjectContentError("tooLarge");
      throw error;
    }
  }
  view.assertHeld();
  if (bytes === null) throw new ProjectContentError("notFound");
  const value = decodeProjectDocument(bytes);
  if (
    value.document.id !== record.id ||
    (record.revisionId === revisionId && stableJson(value.document) !== stableJson(record)) ||
    value.document.spaceId !== record.spaceId ||
    value.revision.id !== revisionId ||
    (summary && stableJson(projectRevisionSummary(value.revision)) !== stableJson(summary))
  )
    throw new ProjectContentError("invalidFile");
  return { revision: value.revision, fileBytes: bytes.length };
}
