import type { DocumentOwnershipRecord, DocumentOwnershipScope } from "../../shared/documents/ownership.js";
import { fileRecord, fileText } from "./codec-values.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { projectContentId } from "./paths.js";
import { ProjectContentError } from "./errors.js";
import type { ProjectContentView } from "./read-view.js";

export const projectDocumentOwnershipFile = (id: string) =>
  "document-ownership/" + projectContentId(id) + ".panda.json";
const uuid = (value: unknown) => {
  const id = fileText(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new ProjectContentError("invalidFile");
  return id;
};
export function documentOwnershipScope(value: unknown): DocumentOwnershipScope {
  const v = fileRecord(value, ["projectId", "personalOwnerHash"]),
    projectId = projectContentId(v.projectId);
  if (projectId === "personal") {
    if (typeof v.personalOwnerHash !== "string" || !/^[a-f0-9]{64}$/.test(v.personalOwnerHash))
      throw new ProjectContentError("invalidFile");
    return { projectId, personalOwnerHash: v.personalOwnerHash };
  }
  if (v.personalOwnerHash !== undefined) throw new ProjectContentError("invalidFile");
  return { projectId };
}
function record(value: unknown): DocumentOwnershipRecord {
  const v = fileRecord(value, [
    "schema",
    "documentId",
    "lineageId",
    "operationId",
    "rootDocumentId",
    "manifestHash",
    "kind",
    "from",
    "to",
  ]);
  if (
    v.schema !== 1 ||
    !["incoming", "active", "outgoing"].includes(String(v.kind)) ||
    typeof v.manifestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.manifestHash)
  )
    throw new ProjectContentError("invalidFile");
  const from = documentOwnershipScope(v.from),
    to = documentOwnershipScope(v.to);
  if (from.projectId === to.projectId && from.personalOwnerHash === to.personalOwnerHash)
    throw new ProjectContentError("invalidFile");
  return {
    schema: 1,
    documentId: projectContentId(v.documentId),
    lineageId: uuid(v.lineageId),
    operationId: uuid(v.operationId),
    rootDocumentId: projectContentId(v.rootDocumentId),
    manifestHash: v.manifestHash,
    kind: v.kind as DocumentOwnershipRecord["kind"],
    from,
    to,
  };
}
export const decodeDocumentOwnership = (value: string | Uint8Array) => decodeContentJson(value, record);
export const encodeDocumentOwnership = (value: DocumentOwnershipRecord) => encodeContentJson(value, record);
export async function readDocumentOwnership(view: ProjectContentView, id: string) {
  const bytes = await view.read(projectDocumentOwnershipFile(id));
  if (bytes === null) return null;
  const value = decodeDocumentOwnership(bytes);
  if (value.documentId !== id) throw new ProjectContentError("invalidFile");
  return value;
}
