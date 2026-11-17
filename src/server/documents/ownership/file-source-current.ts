import type { DocumentAsset, DocumentRecord } from "../../../shared/documents/contracts.js";
import { documentSubtree, type DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import type { DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import type { ProjectContentProject } from "../../project-content/project.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { readDocumentOwnership } from "../../project-content/ownership-file.js";
import { readFileTree } from "../files/navigation/read.js";
import { readFileSavedDocument } from "../files/saved-queries.js";
import { DocumentError } from "../errors.js";

export interface FileOwnershipCurrent {
  projectId: string;
  rootDocumentId: string;
  commit: string;
  nodes: (DocumentTreePlacement & { document: DocumentRecord })[];
  assets: DocumentAsset[];
  ownership: DocumentOwnershipRecord[];
}
export async function readFileOwnershipCurrent(
  project: ProjectContentProject,
  view: ProjectContentView,
  projectId: string,
  rootDocumentId: string,
): Promise<FileOwnershipCurrent> {
  const tree = await readFileTree(view, projectId);
  if (!tree.tree.nodes.some((node) => node.documentId === rootDocumentId)) throw new DocumentError("notFound", 404);
  const ids = new Set(documentSubtree(tree.tree.nodes, rootDocumentId)),
    nodes = tree.tree.nodes.filter((node) => ids.has(node.documentId)),
    assets: DocumentAsset[] = [],
    ownership: DocumentOwnershipRecord[] = [];
  for (const node of nodes) {
    const detail = await readFileSavedDocument(view, projectId, node.documentId),
      draft = await project.drafts.snapshot(view, detail);
    if (draft.dirty || draft.stale) throw new DocumentError("workingCopyChanged", 409);
    assets.push(...(await project.assets.listIn(view, node.documentId)));
    const location = await readDocumentOwnership(view, node.documentId);
    if (location) {
      if (location.kind !== "active" || location.to.projectId !== projectId) throw new DocumentError("conflict", 409);
      ownership.push(location);
    }
  }
  return structuredClone({
    projectId,
    rootDocumentId,
    commit: view.commit,
    nodes,
    assets: assets.sort((a, b) => a.id.localeCompare(b.id, "en")),
    ownership: ownership.sort((a, b) => a.documentId.localeCompare(b.documentId, "en")),
  });
}
export const comparableOwnershipCurrent = ({ commit: _commit, ...current }: FileOwnershipCurrent) => current;
