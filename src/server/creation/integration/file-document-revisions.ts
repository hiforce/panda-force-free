import type { ProjectDocumentQueries } from "../../documents/editor-port.js";
import type { ProjectDocumentChanges } from "../../documents/saved-edits-port.js";
import type { CreationDocumentRevisions } from "../ports.js";
import { documentRevisionReference } from "../../documents/navigation/revision-source.js";
import { richDocumentFromMarkdown, richDocumentInput } from "../../documents/rich-codec.js";
import { CreationError } from "../contracts.js";
import { creationDocumentImages } from "./document-port.js";
export function fileCreationDocumentRevisions(
  application: (owner: string) => {
    queries: Pick<ProjectDocumentQueries, "editor" | "revision">;
    changes: ProjectDocumentChanges;
  },
  tree: (project: string) => Promise<{ version: number }>,
): CreationDocumentRevisions {
  return {
    read: async (owner, project, id) => {
      const snapshot = await application(owner).queries.editor(project, id);
      if (snapshot.draft.dirty || snapshot.draft.stale) throw new CreationError("conflict");
      const detail = snapshot.saved;
      return {
        base: documentRevisionReference(detail),
        document: {
          title: detail.revision.title,
          body: detail.revision.body || richDocumentFromMarkdown(detail.revision.content),
        },
      };
    },
    save: async (task, digest, body) => {
      const base = task.target.document;
      if (!base) throw new CreationError("invalidInput");
      const documents = application(task.owner),
        original = await documents.queries.revision(task.projectId, base.documentId, base.revisionId);
      if (original.contentHash !== base.contentHash || original.number !== base.version)
        throw new CreationError("conflict");
      const source = richDocumentInput(body),
        result = await documents.changes.apply(task.owner, task.projectId, base.documentId, {
          operationId: task.operationId,
          expectedRevisionId: base.revisionId,
          expectedVersion: base.version,
          expectedContentHash: base.contentHash,
          intentHash: digest,
          content: {
            title: original.title,
            locale: original.locale,
            content: source.content,
            body: source.body,
            resources: original.resources || [],
          },
        });
      return {
        kind: "document",
        projectId: task.projectId,
        documentId: base.documentId,
        operationId: task.operationId,
        treeVersion: (await tree(task.projectId)).version,
        title: result.detail.document.title,
        revisionId: result.detail.revision.id,
        revision: result.detail.document.revision,
      };
    },
  };
}

export function creationFileDocuments(application: {
  navigation: import("./document-port.js").CreationDocumentPort;
  queries: Pick<ProjectDocumentQueries, "editor" | "revision">;
  changes: ProjectDocumentChanges;
  assets?: Pick<import("../../documents/asset-port.js").ProjectDocumentAssets, "content">;
}): import("./document-port.js").CreationDocumentPort {
  const navigation = application.navigation;
  return {
    images: application.assets
      ? creationDocumentImages(
          async () => application.assets!,
          async () => {},
        )
      : undefined,
    tree: (project) => navigation.tree(project),
    createFromSource: (actor, input, source) => navigation.createFromSource(actor, input, source),
    appendFromSource: (actor, input, source) => navigation.appendFromSource(actor, input, source),
    revisions: fileCreationDocumentRevisions(
      () => application,
      (project) => navigation.tree(project),
    ),
  };
}
