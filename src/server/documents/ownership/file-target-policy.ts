import { stableJson } from "../../../shared/stable-json.js";
import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import type { ProjectContentProject } from "../../project-content/project.js";
import { projectDocumentFile } from "../../project-content/paths.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { readDocumentOwnership } from "../../project-content/ownership-file.js";
import { projectRevisionSummary } from "../../project-content/document-history.js";
import { readFileTree } from "../files/navigation/read.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { DocumentError } from "../errors.js";
import type { DocumentOwnershipInventory, DocumentOwnershipOriginals, DocumentOwnershipPlan } from "./contracts.js";

export async function ownershipTargetPrefix(
  projects: DocumentFileProjects,
  plan: DocumentOwnershipPlan,
  inventory: DocumentOwnershipInventory,
  documentId: string,
  source: DocumentOwnershipOriginals,
) {
  const node = inventory.nodes.find((row) => row.documentId === documentId)!;
  const existing = await projects.ifPresent(plan.to.projectId, async (project, view) => {
    const tree = await readFileTree(view, plan.to.projectId),
      blob = view.version(projectDocumentFile(documentId)),
      marker = await readDocumentOwnership(view, documentId);
    if (!blob) {
      if (marker) throw new DocumentError("conflict", 409);
      return null;
    }
    const document = (await readProjectDocumentMetadata(view, documentId)).document,
      lineage = plan.lineages.find((row) => row.documentId === documentId)!.lineageId;
    if (
      !marker ||
      marker.lineageId !== lineage ||
      document.revision > node.document.revision ||
      marker.kind === "active" ||
      tree.tree.nodes.some((row) => row.documentId === documentId) ||
      (marker.kind === "incoming" &&
        (stableJson(marker.from) !== stableJson(plan.from) || stableJson(marker.to) !== stableJson(plan.to)))
    )
      throw new DocumentError("conflict", 409);
    const sourceAssets = new Map(
      inventory.assets.filter((row) => row.documentId === documentId).map((row) => [row.id, row]),
    );
    for (const asset of await project.assets.listIn(view, documentId))
      if (stableJson(sourceAssets.get(asset.id)) !== stableJson(asset)) throw new DocumentError("conflict", 409);
    return { project, document, marker, blob, commit: view.commit };
  });
  if (!existing) return null;
  let cursor: string | null = existing.commit,
    number = existing.document.revision;
  while (cursor) {
    await projects.authorize(plan.to.projectId);
    const page = await existing.project.documents.revisionPage(documentId, 100, cursor);
    for (const row of page.revisions) {
      const expected = inventory.revisions.find(
        (item) => item.documentId === documentId && item.number === row.revision.number,
      );
      if (row.revision.number !== number-- || stableJson(expected) !== stableJson(row.revision))
        throw new DocumentError("conflict", 409);
      const [original, target] = await Promise.all([
        source.version(documentId, row.revision.id),
        existing.project.documents.revision(documentId, row.revision.id, existing.commit),
      ]);
      if (stableJson(original.revision) !== stableJson(target)) throw new DocumentError("conflict", 409);
    }
    cursor = page.nextCommit;
  }
  if (number !== 0) throw new DocumentError("conflict", 409);
  await projects.authorize(plan.to.projectId);
  return existing;
}
export function ownershipTargetDetail(
  original: DocumentDetail,
  inventory: DocumentOwnershipInventory,
  documentId: string,
  spaceId: string,
  path: string,
): DocumentDetail {
  const expected = inventory.revisions.find((row) => row.documentId === documentId && row.id === original.revision.id),
    node = inventory.nodes.find((row) => row.documentId === documentId);
  if (
    !node ||
    !expected ||
    original.document.id !== documentId ||
    stableJson(projectRevisionSummary(original.revision)) !== stableJson(expected)
  )
    throw new DocumentError("conflict", 409);
  return {
    document: {
      ...(original.revision.number === node.document.revision ? node.document : original.document),
      spaceId,
      path,
    },
    revision: original.revision,
  };
}
export async function ownershipTargetProject(
  projects: DocumentFileProjects,
  projectId: string,
): Promise<ProjectContentProject> {
  return projects.view(projectId, async (project) => project);
}
