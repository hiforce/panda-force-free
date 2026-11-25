import type { CreationAssetArtifact, CreationDocumentArtifact } from "../../shared/creation/contracts.js";

/** Resolve saved document receipts through the same authorized document workspace. */
export function creationDocumentRoute(artifact: Pick<CreationDocumentArtifact, "projectId" | "documentId">) {
  return (
    "/documents?" +
    new URLSearchParams({
      project: artifact.projectId,
      document: artifact.documentId,
    })
  );
}

export function personalCreationAssetRoute(artifact: Pick<CreationAssetArtifact, "kind" | "assetId" | "version">) {
  return (
    "/create?" +
    new URLSearchParams({
      view: "works",
      category: artifact.kind,
      asset: artifact.assetId,
      assetVersion: artifact.version,
    })
  );
}
