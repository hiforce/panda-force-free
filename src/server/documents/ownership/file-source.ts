import {
  readFileOwnershipCurrent,
  comparableOwnershipCurrent,
  type FileOwnershipCurrent,
} from "./file-source-current.js";
import { stableJson } from "../../../shared/stable-json.js";
import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import { projectDocumentFile } from "../../project-content/paths.js";
import { decodeProjectDocument } from "../../project-content/document-file.js";
import { projectRevisionSummary, type ProjectRevisionSummary } from "../../project-content/document-history.js";
import type { DocumentFileProjects } from "../files/projects.js";
import { DocumentAssetDirectories } from "../files/asset-directories.js";
import { DocumentError } from "../errors.js";

export interface FileOwnershipSnapshot extends FileOwnershipCurrent {
  versions: { commit: string; revision: ProjectRevisionSummary }[];
}

/** A transfer reads original Git versions and owned image bytes; a recent UI revision list is never its inventory. */
export class FileDocumentOwnershipSource {
  inventory(snapshot: FileOwnershipSnapshot) {
    const { commit: _commit, versions, ...current } = structuredClone(snapshot);
    return { ...current, revisions: versions.map((row) => row.revision) };
  }
  private readonly directories: DocumentAssetDirectories;
  constructor(
    private readonly projects: DocumentFileProjects,
    assetRoot: string,
  ) {
    this.directories = new DocumentAssetDirectories(assetRoot);
  }
  private current(projectId: string, rootDocumentId: string) {
    return this.projects.view(projectId, (project, view) =>
      readFileOwnershipCurrent(project, view, projectId, rootDocumentId),
    );
  }
  async capture(projectId: string, rootDocumentId: string): Promise<FileOwnershipSnapshot> {
    const current = await this.current(projectId, rootDocumentId),
      project = await this.projects.view(projectId, async (owner) => owner),
      versions: FileOwnershipSnapshot["versions"] = [];
    for (const node of current.nodes) {
      let commit: string | null = current.commit,
        nextNumber = node.document.revision;
      const seen = new Set<string>();
      while (commit) {
        await this.projects.authorize(projectId);
        const page = await project.documents.revisionPage(node.documentId, 100, commit);
        for (const row of page.revisions) {
          if (
            row.revision.documentId !== node.documentId ||
            row.revision.number !== nextNumber-- ||
            seen.has(row.revision.id)
          )
            throw new DocumentError("conflict", 409);
          seen.add(row.revision.id);
          versions.push(row);
        }
        commit = page.nextCommit;
      }
      if (nextNumber !== 0) throw new DocumentError("conflict", 409);
    }
    await this.assertCurrent({ ...current, versions });
    return { ...current, versions };
  }
  async assertCurrent(snapshot: FileOwnershipSnapshot) {
    snapshot = structuredClone(snapshot);
    const expected: FileOwnershipCurrent = {
        projectId: snapshot.projectId,
        rootDocumentId: snapshot.rootDocumentId,
        commit: snapshot.commit,
        nodes: snapshot.nodes,
        assets: snapshot.assets,
        ownership: snapshot.ownership,
      },
      actual = await this.current(expected.projectId, expected.rootDocumentId);
    if (stableJson(comparableOwnershipCurrent(expected)) !== stableJson(comparableOwnershipCurrent(actual)))
      throw new DocumentError("conflict", 409);
  }
  async version(input: FileOwnershipSnapshot, documentId: string, revisionId: string) {
    const snapshot = structuredClone(input),
      selected = snapshot.versions.find(
        (row) => row.revision.documentId === documentId && row.revision.id === revisionId,
      );
    if (!selected || !snapshot.nodes.some((node) => node.documentId === documentId))
      throw new DocumentError("notFound", 404);
    const project = await this.projects.view(snapshot.projectId, async (owner) => owner),
      bytes = await new ProjectGitSnapshots(project.owned).fileAt(selected.commit, projectDocumentFile(documentId));
    if (!bytes) throw new DocumentError("sourceUnavailable", 503);
    const detail = decodeProjectDocument(bytes);
    if (
      detail.document.id !== documentId ||
      stableJson(projectRevisionSummary(detail.revision)) !== stableJson(selected.revision)
    )
      throw new DocumentError("conflict", 409);
    await this.projects.authorize(snapshot.projectId);
    return detail;
  }
  async image(input: FileOwnershipSnapshot, id: string) {
    const snapshot = structuredClone(input),
      asset = snapshot.assets.find((row) => row.id === id);
    if (!asset || !snapshot.nodes.some((node) => node.documentId === asset.documentId))
      throw new DocumentError("notFound", 404);
    const project = await this.projects.view(snapshot.projectId, async (owner) => owner),
      bytes = await (await this.directories.open(project.owned)).read(asset.digest, asset.size);
    await this.projects.authorize(snapshot.projectId);
    return { asset, bytes };
  }
}
