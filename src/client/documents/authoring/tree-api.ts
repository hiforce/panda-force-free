import { documentJson as json, DocumentApiError } from "../api.js";
import type {
  DocumentTreeMutation,
  ProjectDocumentTree,
  DocumentTreeTarget,
  DocumentTreeTrashPage,
} from "../../../shared/documents/navigation.js";
import type { DocumentTemplateRequest } from "../../../shared/templates/application.js";

export type TreeIntent =
  | { kind: "create"; title: string; locale: string; parentId: string | null }
  | ({ kind: "create-template"; title: string; locale: string; parentId: string | null } & DocumentTemplateRequest)
  | { kind: "move"; documentId: string; target: DocumentTreeTarget }
  | { kind: "rename"; documentId: string; title: string; revision: number }
  | { kind: "trash"; documentId: string; revision: number }
  | { kind: "restore"; documentId: string; toRoot?: boolean };
export interface FrozenTreeCommand {
  id: string;
  projectId: string;
  treeVersion: number;
  intent: TreeIntent;
}
export interface DocumentTreePort {
  read(project: string, signal?: AbortSignal): Promise<ProjectDocumentTree>;
  commit(command: FrozenTreeCommand): Promise<DocumentTreeMutation>;
  definitive(error: unknown): boolean;
}
export const documentTreeApi: DocumentTreePort = {
  read: (project, signal) =>
    json<ProjectDocumentTree>(
      "/api/project-document-tree?" + new URLSearchParams({ project }),
      "GET",
      undefined,
      signal,
    ),
  commit: ({ intent, id, projectId, treeVersion }) => {
    const { kind, ...fields } = intent,
      body = { id, projectId, treeVersion, ...fields };
    return kind === "create-template"
      ? json<DocumentTreeMutation>("/api/project-documents/from-template", "POST", body)
      : kind === "create"
        ? json<DocumentTreeMutation>("/api/project-document-tree/documents", "POST", body)
        : json<DocumentTreeMutation>("/api/project-document-tree/actions", "POST", { ...body, action: kind });
  },
  definitive: (error) =>
    error instanceof DocumentApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status),
};
export const documentTreeTrash = (project: string, cursor?: string) =>
  json<DocumentTreeTrashPage>(
    "/api/project-document-tree/trash?" + new URLSearchParams({ project, ...(cursor ? { cursor } : {}) }),
  );
