import { CreationError } from "../contracts.js";
import { documentRevisionReference } from "../../documents/navigation/revision-source.js";
import { richDocumentFromMarkdown } from "../../documents/rich-codec.js";
async function legacyCreationDocumentRead(
  existing:
    Pick<ProjectDocumentNavigation, "currentFromSource"> | Pick<MySQLProjectDocumentNavigation, "currentFromSource">,
  project: string,
  id: string,
) {
  const detail = await existing.currentFromSource(project, id);
  return {
    base: documentRevisionReference(detail),
    document: {
      title: detail.revision.title,
      body: detail.revision.body || richDocumentFromMarkdown(detail.revision.content),
    },
  };
}
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { MySQLProjectDocumentNavigation } from "../../documents/navigation/mysql-service.js";
import type { ProjectDocumentNavigation } from "../../documents/navigation/service.js";

export type CreationDocumentPort = Pick<FileDocumentNavigation, "tree" | "createFromSource" | "appendFromSource"> & {
  location?(
    owner: string,
    projectId: string,
    documentId: string,
  ): Promise<{ projectId: string; projectName?: string } | null>;
  revisions?: import("../ports.js").CreationDocumentRevisions;
  images?: {
    read(owner: string, project: string, documentId: string, assetId: string): Promise<Uint8Array>;
  };
};

/** Read only an image that belongs to this exact document through its authorized storage adapter. */
export function creationDocumentImages(
  assets: (
    owner: string,
    project: string,
  ) => Promise<Pick<import("../../documents/asset-port.js").ProjectDocumentAssets, "content">>,
  authorize: (owner: string, project: string) => void | Promise<void>,
): NonNullable<CreationDocumentPort["images"]> {
  return {
    read: async (owner, project, documentId, assetId) => {
      await authorize(owner, project);
      const result = await (await assets(owner, project)).content(project, assetId);
      if (result.asset.id !== assetId || result.asset.documentId !== documentId) throw new CreationError("notFound");
      await authorize(owner, project);
      return new Uint8Array(result.bytes);
    },
  };
}

/** Generated documents use the same project backend as manual creation, retaining existing document identities. */
export function projectCreationDocuments(
  files: (project: string) => boolean | Promise<boolean>,
  current: CreationDocumentPort,
  existing:
    | Pick<
        ProjectDocumentNavigation,
        "tree" | "createFromSource" | "appendFromSource" | "currentFromSource" | "reviseFromSource"
      >
    | Pick<
        MySQLProjectDocumentNavigation,
        "tree" | "createFromSource" | "appendFromSource" | "currentFromSource" | "reviseFromSource"
      >,
  authorize: (owner: string, project: string) => void | Promise<void>,
): CreationDocumentPort {
  return {
    images: current.images,
    revisions: {
      read: async (owner, project, id) => {
        await authorize(owner, project);
        const result = await ((await files(project))
          ? current.revisions?.read(owner, project, id)
          : legacyCreationDocumentRead(existing, project, id));
        if (!result) throw new CreationError("unavailable");
        await authorize(owner, project);
        return result;
      },
      save: async (task, digest, body) => {
        await authorize(task.owner, task.projectId);
        if (await files(task.projectId)) {
          if (!current.revisions) throw new CreationError("unavailable");
          return current.revisions.save(task, digest, body);
        }
        const result = await existing.reviseFromSource(
          task.owner,
          { id: task.operationId, projectId: task.projectId, base: task.target.document },
          { identity: "creation-revision:" + digest, prepare: async () => ({ body, images: [] }) },
          () => authorize(task.owner, task.projectId),
        );
        return {
          kind: "document",
          projectId: task.projectId,
          documentId: result.operation.documentId,
          operationId: task.operationId,
          treeVersion: result.operation.treeVersion,
          revisionId: result.operation.sourceRevision.revisionId,
          revision: result.operation.sourceRevision.version,
        };
      },
    },
    tree: async (project) => ((await files(project)) ? current.tree(project) : existing.tree(project)),
    createFromSource: async (actor, input, source) => {
      const project = projectId(input);
      await authorize(actor, project);
      return (await files(project))
        ? current.createFromSource(actor, input, source)
        : existing.createFromSource(actor, input, source, () => authorize(actor, project));
    },
    appendFromSource: async (actor, input, source) => {
      const project = projectId(input);
      await authorize(actor, project);
      return (await files(project))
        ? current.appendFromSource(actor, input, source)
        : existing.appendFromSource(actor, input, source, () => authorize(actor, project));
    },
  };
}

function projectId(input: unknown): string {
  return input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof (input as Record<string, unknown>).projectId === "string"
    ? (input as { projectId: string }).projectId
    : "";
}
