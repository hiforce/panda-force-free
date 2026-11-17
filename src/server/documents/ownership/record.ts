import type { DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import { stableJson } from "../../../shared/stable-json.js";
import { encodeDocumentOwnership, decodeDocumentOwnership } from "../../project-content/ownership-file.js";
import { DocumentError } from "../errors.js";

export function sqlOwnershipRecord(text: string, documentId: string, projectId: string) {
  try {
    const record = decodeDocumentOwnership(text);
    if (
      record.documentId !== documentId ||
      (record.kind === "outgoing" ? record.from : record.to).projectId !== projectId
    )
      throw Error("Ownership mismatch");
    return record;
  } catch {
    throw new DocumentError("sourceUnavailable", 503);
  }
}
export function ownershipRecordText(record: DocumentOwnershipRecord) {
  try {
    return encodeDocumentOwnership(record);
  } catch {
    throw new DocumentError("invalidInput");
  }
}
export function assertOwnershipTransition(before: DocumentOwnershipRecord | null, after: DocumentOwnershipRecord) {
  ownershipRecordText(after);
  if (!before) {
    if (after.kind === "active") throw new DocumentError("conflict", 409);
    return;
  }
  if (stableJson(before) === stableJson(after)) return;
  if (
    before.lineageId !== after.lineageId ||
    before.documentId !== after.documentId ||
    !(
      (before.kind === "active" && after.kind === "outgoing") ||
      (before.kind === "outgoing" && after.kind === "incoming") ||
      (before.kind === "incoming" && after.kind === "incoming") ||
      (before.kind === "incoming" &&
        after.kind === "active" &&
        before.operationId === after.operationId &&
        before.manifestHash === after.manifestHash)
    )
  )
    throw new DocumentError("conflict", 409);
}
export function assertOwnershipVisible(record: DocumentOwnershipRecord | null) {
  if (record && record.kind !== "active") throw new DocumentError("notFound", 404);
}
