import type { DocumentPlacement } from "../../shared/documents/placements.js";
import { compatibleDocumentLocale } from "../../shared/documents/locales.js";
import { ProjectDocumentHistory } from "./document-history.js";
import { decodeProjectDocument } from "./document-file.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import { ProjectContentError } from "./errors.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { decodeProjectNavigation } from "./navigation-file.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectDocumentFile, projectDocumentId, projectSpaceFile } from "./paths.js";
import { readProjectManifest } from "./project-manifest.js";
import type { ProjectContentView } from "./read-view.js";
import { decodeProjectSpace } from "./space-file.js";
import { assertSpaceMembership, readSpaceMetadata } from "./space-read.js";

const pathKey = (value: string) => value.normalize("NFC").toLowerCase();

/** References are checked against one captured project version, including pinned historical revisions. */
export async function placementScope(view: ProjectContentView, owned: OwnedProjectDirectory, value: DocumentPlacement) {
  const manifest = await readProjectManifest(view, owned.projectId);
  if (!manifest.spaceIds.includes(value.spaceId)) throw new ProjectContentError("notFound");
  const bytes = await view.read(projectSpaceFile(value.spaceId));
  if (bytes === null) throw new ProjectContentError("invalidFile");
  const target = decodeProjectSpace(bytes);
  assertSpaceMembership(target.space, manifest, value.spaceId);
  if (manifest.librarySpaceId === value.spaceId) throw new ProjectContentError("invalidFile");
  // Removing an existing link remains possible after its source is trashed or unavailable.
  if (value.deletedAt !== null) return { target, trash: new Set<string>() };
  const sourceBytes = await view.read(projectDocumentFile(value.documentId));
  if (sourceBytes === null) throw new ProjectContentError("notFound");
  const source = decodeProjectDocument(sourceBytes);
  if (source.document.id !== value.documentId) throw new ProjectContentError("invalidFile");
  await readSpaceMetadata(view, manifest, source.document.spaceId);
  if (source.document.spaceId === value.spaceId) throw new ProjectContentError("invalidFile");
  const treeBytes = await view.read("tree.json"),
    tree = treeBytes === null ? null : decodeProjectNavigation(treeBytes);
  if (
    tree &&
    (tree.projectId !== owned.projectId || tree.spaces.some((row) => !manifest.spaceIds.includes(row.spaceId)))
  )
    throw new ProjectContentError("invalidFile");
  const trash = new Set(tree?.spaces.flatMap((row) => row.trash.map((entry) => entry.documentId)) ?? []);
  if (trash.has(value.documentId)) throw new ProjectContentError("notFound");
  let revision = source.revision;
  if (value.revisionId !== null && value.revisionId !== revision.id) {
    const rows = await new ProjectDocumentHistory(owned).list(value.documentId, value.revisionId, 2, view.commit);
    if (rows.length !== 1) throw new ProjectContentError("notFound");
    const bytes = await new ProjectGitSnapshots(owned).fileAt(rows[0]!.commit, projectDocumentFile(value.documentId));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const original = decodeProjectDocument(bytes);
    if (original.document.id !== value.documentId || original.revision.id !== value.revisionId)
      throw new ProjectContentError("invalidFile");
    revision = original.revision;
  }
  if (!compatibleDocumentLocale(revision.locale, value.locale)) throw new ProjectContentError("conflict");
  return { target, trash };
}

/** Uniqueness uses the same portable path key for originals and placements; trashed originals release their path. */
export async function placementAvailable(
  view: ProjectContentView,
  value: DocumentPlacement,
  records: readonly DocumentPlacement[],
  trash: ReadonlySet<string>,
) {
  const active = records.filter(
    (row) => row.spaceId === value.spaceId && row.deletedAt === null && row.id !== value.id,
  );
  if (
    active.length >= 500 ||
    active.some(
      (row) =>
        pathKey(row.path) === pathKey(value.path) ||
        (row.documentId === value.documentId && row.locale.toLowerCase() === value.locale.toLowerCase()),
    )
  )
    throw new ProjectContentError("conflict");
  for (const path of view.paths) {
    const id = projectDocumentId(path);
    if (id === null || trash.has(id)) continue;
    const { document } = await readProjectDocumentMetadata(view, id);
    if (document.spaceId === value.spaceId && pathKey(document.path) === pathKey(value.path))
      throw new ProjectContentError("conflict");
  }
}
