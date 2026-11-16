import type { DocumentRecord } from "../../shared/documents/contracts.js";
import { ProjectContentError } from "./errors.js";
import { decodeProjectDocumentRecord } from "./document-record.js";
import { projectDocumentFile } from "./paths.js";
import type { ProjectContentView } from "./read-view.js";
import type { ProjectFileReader } from "./file-reader.js";
import { inspectContentHeader } from "./header-reader.js";

export interface ProjectDocumentMetadata {
  document: DocumentRecord;
  fileBytes: number;
}

/** A metadata summary is not full original/checksum validation. */
export async function inspectProjectDocument(file: ProjectFileReader): Promise<ProjectDocumentMetadata> {
  const value = await inspectContentHeader(file, "document", decodeProjectDocumentRecord);
  return { document: value.record, fileBytes: value.fileBytes };
}

export async function readProjectDocumentMetadata(
  view: ProjectContentView,
  id: string,
): Promise<ProjectDocumentMetadata> {
  const result = await view.inspect(projectDocumentFile(id), inspectProjectDocument);
  if (result.document.id !== id) throw new ProjectContentError("invalidFile");
  return result;
}
