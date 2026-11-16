import type { DocumentAsset, DocumentRevision } from "../../../shared/documents/contracts.js";
import type {
  DocumentCheckpointResult,
  DocumentDraftAcknowledgement,
  DocumentEditorSnapshot,
  DocumentWorkingContent,
} from "../../../shared/documents/working-copy.js";
import { documentJson as json, DocumentApiError } from "../api.js";
import { request } from "../../http-client.js";
import { personalContentPath } from "../../../shared/creative/scope.js";

export interface FileEditorCommand {
  kind: "autosave" | "discard" | "save" | "restore";
  input: {
    operationId: string;
    version?: number;
    baseRevisionId?: string;
    working?: DocumentWorkingContent;
    revisionId?: string;
    draftVersion?: number;
    restoreRevisionId?: string;
  };
}
export interface FileEditorApi {
  open(): Promise<DocumentEditorSnapshot>;
  execute(command: FileEditorCommand): Promise<DocumentDraftAcknowledgement | DocumentCheckpointResult>;
}
export function fileDocumentApi(project: string, id: string) {
  const scope = new URLSearchParams({ project, id }).toString();
  return {
    open: () => json<DocumentEditorSnapshot>("/api/project-documents/editor?" + scope),
    execute: (command: FileEditorCommand) =>
      command.kind === "autosave" || command.kind === "discard"
        ? json<{ receipt: DocumentDraftAcknowledgement }>(
            "/api/project-documents/editor?" + scope,
            command.kind === "discard" ? "DELETE" : "PUT",
            command.input,
          ).then((result) => result.receipt)
        : json<DocumentCheckpointResult>(
            "/api/project-documents/checkpoints" + (command.kind === "restore" ? "/restore" : "") + "?" + scope,
            "POST",
            command.input,
          ),
    history: () =>
      json<{ revisions: Omit<DocumentRevision, "content" | "body" | "resources">[] }>(
        "/api/project-documents/revisions?" + scope,
      ),
    revision: (revision: string) =>
      json<{ revision: DocumentRevision }>(
        "/api/project-documents/revisions?" + scope + "&" + new URLSearchParams({ revision }),
      ),
    imageUrl: (asset: string) =>
      personalContentPath("/api/project-documents/assets/content?" + new URLSearchParams({ project, id: asset })),
    async upload(file: File) {
      const response = await request(
        personalContentPath(
          "/api/project-documents/assets?" +
            new URLSearchParams({ project, document: id, name: file.name, operationId: crypto.randomUUID() }),
        ),
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      );
      const payload = await response.json();
      if (!response.ok) throw new DocumentApiError(response.status, payload);
      return (payload as { asset: DocumentAsset }).asset;
    },
  };
}
