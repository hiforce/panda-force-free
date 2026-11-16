import type { DocumentDetail } from "../../shared/documents/contracts.js";
import { decodeProjectDocument } from "./document-file.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import type { ProjectDocumentHistory } from "./document-history.js";
import { ProjectContentError } from "./errors.js";
import { projectDocumentId } from "./paths.js";
import type { ProjectContentView } from "./read-view.js";

export function validateDocumentRevision(detail: DocumentDetail, expectedRevision: number | null) {
  if (
    (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) ||
    detail.document.revision !== (expectedRevision ?? 0) + 1
  )
    throw new ProjectContentError("invalidFile");
}
/** Import and interactive checkpoint plans share revision identity, source-space and path guards under one lease. */
export async function assertDocumentTransition(
  view: ProjectContentView,
  previous: Buffer | null,
  detail: DocumentDetail,
  expectedRevision: number | null,
  history: ProjectDocumentHistory,
): Promise<undefined> {
  const id = detail.document.id;
  if (expectedRevision === null) {
    if (previous !== null) throw new ProjectContentError("conflict");
  } else {
    if (previous === null) throw new ProjectContentError("notFound");
    const current = decodeProjectDocument(previous);
    if (current.document.id !== id) throw new ProjectContentError("invalidFile");
    if (
      current.document.revision !== expectedRevision ||
      current.document.spaceId !== detail.document.spaceId ||
      current.revision.id === detail.revision.id
    )
      throw new ProjectContentError("conflict");
  }
  if (await history.hasRevision(detail.revision.id)) throw new ProjectContentError("conflict");
  for (const candidate of view.paths) {
    const otherId = projectDocumentId(candidate);
    if (otherId === null || otherId === id) continue;
    const { document } = await readProjectDocumentMetadata(view, otherId);
    if (document.revisionId === detail.revision.id) throw new ProjectContentError("conflict");
    if (document.spaceId === detail.document.spaceId && document.path === detail.document.path)
      throw new ProjectContentError("conflict");
  }
  return undefined;
}
