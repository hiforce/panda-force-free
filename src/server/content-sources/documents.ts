import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { savedDocumentText } from "../../shared/documents/plain-text.js";
import type { ProjectContentView } from "../project-content/read-view.js";
import { readProjectManifest } from "../project-content/project-manifest.js";
import { readSpaceMetadata } from "../project-content/space-read.js";
import { decodeProjectNavigation } from "../project-content/navigation-file.js";
import { readProjectDocumentMetadata } from "../project-content/document-metadata.js";
import { decodeProjectDocument } from "../project-content/document-file.js";
import { projectDocumentFile, projectDocumentId } from "../project-content/paths.js";
import { ProjectContentError } from "../project-content/errors.js";

interface SavedDocumentIdentity {
  id: string;
  parentId: string | null;
  spaceId: string;
  version: string;
}

/** Saved document identities and text share one file authority across spaces, excluding trash and working drafts. */
export async function savedDocumentSources(view: ProjectContentView, project: string, requested?: ReadonlySet<string>) {
  const manifest = await readProjectManifest(view, project),
    bytes = await view.read("tree.json"),
    tree = bytes === null ? null : decodeProjectNavigation(bytes),
    documents = new Map<string, SavedDocumentIdentity>(),
    trash = new Set(tree?.spaces.flatMap((space) => space.trash.map((row) => row.documentId))),
    spaces = new Map<string, DocumentSpace>();
  if (tree && (tree.projectId !== project || tree.spaces.some((space) => !manifest.spaceIds.includes(space.spaceId))))
    throw new ProjectContentError("invalidFile");
  const space = async (id: string) => {
    if (!spaces.has(id)) spaces.set(id, await readSpaceMetadata(view, manifest, id));
  };
  const add = (id: string, spaceId: string, parentId: string | null) => {
    const version = view.version(projectDocumentFile(id));
    if (!version) throw new ProjectContentError("invalidFile");
    documents.set(id, { id, parentId, spaceId, version });
  };
  for (const state of tree?.spaces ?? []) {
    if (state.nodes.length) await space(state.spaceId);
    for (const node of state.nodes) add(node.documentId, state.spaceId, node.parentId);
  }
  for (const path of view.paths) {
    const id = projectDocumentId(path);
    if (id === null || trash.has(id) || documents.has(id) || (requested && !requested.has(id))) continue;
    // Imported saved documents can precede navigation. Their bounded headers establish space membership.
    const { document } = await readProjectDocumentMetadata(view, id);
    await space(document.spaceId);
    add(id, document.spaceId, null);
  }
  return {
    documents,
    spaces,
    ancestors(id: string) {
      const result: string[] = [],
        seen = new Set([id]);
      let parent = documents.get(id)?.parentId;
      while (parent) {
        if (seen.has(parent) || !documents.has(parent)) throw new ProjectContentError("invalidFile");
        seen.add(parent);
        result.push(parent);
        parent = documents.get(parent)!.parentId;
      }
      return result;
    },
    async read(id: string) {
      const identity = documents.get(id);
      if (!identity) throw new ProjectContentError("notFound");
      const bytes = await view.read(projectDocumentFile(id));
      if (!bytes) throw new ProjectContentError("notFound");
      const detail = decodeProjectDocument(bytes);
      if (detail.document.id !== id || detail.document.spaceId !== identity.spaceId)
        throw new ProjectContentError("invalidFile");
      return { detail, ...savedDocumentText(detail.revision) };
    },
  };
}

export type SavedDocumentSources = Awaited<ReturnType<typeof savedDocumentSources>>;
