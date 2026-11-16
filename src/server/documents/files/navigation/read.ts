import type { DocumentSpace } from "../../../../shared/documents/contracts.js";
import type { ProjectDocumentTree } from "../../../../shared/documents/navigation.js";
import { decodeProjectNavigation, type ProjectNavigationState } from "../../../project-content/navigation-file.js";
import { readProjectDocumentMetadata } from "../../../project-content/document-metadata.js";
import { readProjectManifest } from "../../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../../project-content/space-read.js";
import type { ProjectContentView } from "../../../project-content/read-view.js";
import { ProjectContentError } from "../../../project-content/errors.js";

export interface FileTreeSnapshot {
  space: DocumentSpace | null;
  state: ProjectNavigationState | null;
  tree: ProjectDocumentTree;
}
export async function readFileNavigation(view: ProjectContentView, projectId: string) {
  const manifest = await readProjectManifest(view, projectId),
    bytes = await view.read("tree.json"),
    file = bytes === null ? null : decodeProjectNavigation(bytes);
  if (file && (file.projectId !== projectId || file.spaces.some((state) => !manifest.spaceIds.includes(state.spaceId))))
    throw new ProjectContentError("invalidFile");
  const space =
      manifest.librarySpaceId === null ? null : await readSpaceMetadata(view, manifest, manifest.librarySpaceId),
    state = file?.spaces.find((value) => value.spaceId === space?.id) ?? null;
  return { space, state };
}
export async function readFileTree(view: ProjectContentView, projectId: string): Promise<FileTreeSnapshot> {
  const { space, state } = await readFileNavigation(view, projectId),
    nodes: ProjectDocumentTree["nodes"] = [];
  for (const placement of state?.nodes ?? []) {
    const { document } = await readProjectDocumentMetadata(view, placement.documentId);
    if (document.spaceId !== space?.id) throw new ProjectContentError("invalidFile");
    nodes.push({ ...placement, document });
  }
  return { space, state, tree: { projectId, version: state?.version ?? 0, nodes } };
}
export const emptyNavigation = (spaceId: string): ProjectNavigationState => ({
  spaceId,
  version: 0,
  nodes: [],
  trash: [],
  origins: [],
  lastOperation: null,
});
