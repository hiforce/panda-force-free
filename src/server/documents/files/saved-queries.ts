import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import { readSavedDocument, assertDocumentWritable } from "../../project-content/drafts/current.js";
import { decodeProjectNavigation } from "../../project-content/navigation-file.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { projectDocumentId } from "../../project-content/paths.js";
import { readProjectManifest } from "../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../project-content/space-read.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { DocumentError } from "../errors.js";
import { documentIdentity, type DocumentProjectReads } from "./projects.js";
import { savedSearchVersion } from "./search-version.js";

export async function readFileSavedDocument(
  view: ProjectContentView,
  projectId: string,
  documentId: string,
): Promise<DocumentDetail> {
  documentIdentity(documentId);
  await assertDocumentWritable(view, projectId, documentId);
  const detail = await readSavedDocument(view, projectId, documentId),
    manifest = await readProjectManifest(view, projectId),
    space = await readSpaceMetadata(view, manifest, detail.document.spaceId);
  return { ...detail, engine: space.engine, sourceMode: space.sourceMode };
}
async function searchAncestry(view: ProjectContentView) {
  const bytes = await view.read("tree.json"),
    file = bytes === null ? null : decodeProjectNavigation(bytes),
    parents = new Map<string, string | null>();
  for (const space of file?.spaces ?? []) for (const node of space.nodes) parents.set(node.documentId, node.parentId);
  return (id: string) => {
    const ancestors: string[] = [],
      seen = new Set([id]);
    let parent = parents.get(id);
    while (parent) {
      if (seen.has(parent)) throw new ProjectContentError("invalidFile");
      seen.add(parent);
      ancestors.push(parent);
      parent = parents.get(parent);
    }
    return ancestors;
  };
}

/** Saved-content reads never initialize roots or start editing and creation services. */
export class FileSavedQueries {
  constructor(private readonly reads: DocumentProjectReads) {}

  async savedHead(projectId: string) {
    return (await this.reads.ifPresent(projectId, async (_project, view) => view.commit)) ?? "empty";
  }
  async searchHead(projectId: string) {
    return (await this.reads.ifPresent(projectId, async (_project, view) => savedSearchVersion(view))) ?? "empty";
  }
  async savedBatch(projectId: string, ids: string[]) {
    if (ids.length > 100) throw new DocumentError("invalidInput");
    return (
      (await this.reads.ifPresent(projectId, async (_project, view) => {
        const documents: (DocumentDetail & { ancestors: string[] })[] = [],
          ancestry = await searchAncestry(view);
        for (const id of ids) {
          try {
            documents.push({ ...(await readFileSavedDocument(view, projectId, id)), ancestors: ancestry(id) });
          } catch (error) {
            if (
              (error instanceof DocumentError && error.status === 404) ||
              (error instanceof ProjectContentError && error.code === "notFound")
            )
              continue;
            throw error;
          }
        }
        return documents;
      })) ?? []
    );
  }
  /** An authorized saved snapshot excludes drafts, historical revisions and trashed documents. */
  async savedSnapshot(projectId: string) {
    return (
      (await this.reads.ifPresent(projectId, async (_project, view) => {
        const documents: (DocumentDetail & { ancestors: string[] })[] = [],
          ancestry = await searchAncestry(view);
        for (const path of view.paths) {
          const id = projectDocumentId(path);
          if (id === null) continue;
          try {
            documents.push({ ...(await readFileSavedDocument(view, projectId, id)), ancestors: ancestry(id) });
          } catch (error) {
            if (
              (error instanceof DocumentError && error.status === 404) ||
              (error instanceof ProjectContentError && error.code === "notFound")
            )
              continue;
            throw error;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return { commit: view.commit, searchVersion: savedSearchVersion(view), documents };
      })) ?? { commit: "empty", searchVersion: "empty", documents: [] }
    );
  }
}
