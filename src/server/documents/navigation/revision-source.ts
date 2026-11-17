import type { DocumentDetail, DocumentRevisionReference } from "../../../shared/documents/contracts.js";
import type { DocumentTreeReceipt } from "../../../shared/documents/navigation.js";
import { documentInput, text } from "../validation.js";
import { DocumentError } from "../errors.js";
import { navigationRequest } from "./validation.js";
export function sourceRevisionInput(value: unknown, identity: string) {
  const row = documentInput(value, ["id", "projectId", "base"]),
    base = documentInput(row.base, ["documentId", "revisionId", "version", "contentHash"]);
  const version = base.version,
    contentHash = text(base.contentHash, 64);
  if (!Number.isSafeInteger(version) || Number(version) < 1 || !/^[a-f0-9]{64}$/.test(contentHash))
    throw new DocumentError("invalidInput");
  const result = {
    id: text(row.id, 128),
    projectId: text(row.projectId, 128),
    base: {
      documentId: text(base.documentId, 128),
      revisionId: text(base.revisionId, 128),
      version: Number(version),
      contentHash,
    },
  };
  return {
    ...result,
    request: navigationRequest({ kind: "saved-source-revision", ...result, source: text(identity, 1000) }),
  };
}
export function documentRevisionReference(detail: DocumentDetail): DocumentRevisionReference {
  const record = detail.document;
  return {
    documentId: record.id,
    revisionId: record.revisionId,
    version: record.revision,
    contentHash: record.contentHash,
  };
}
export function assertSourceRevision(detail: DocumentDetail, base: DocumentRevisionReference) {
  const current = documentRevisionReference(detail);
  if (Object.keys(current).some((key) => current[key as keyof typeof current] !== base[key as keyof typeof base]))
    throw new DocumentError("conflict", 409);
}
export type DocumentSourceRevisionReceipt = DocumentTreeReceipt & { sourceRevision: DocumentRevisionReference };
export function sourceRevisionReceipt(receipt: DocumentTreeReceipt): DocumentSourceRevisionReceipt {
  const row = receipt as DocumentSourceRevisionReceipt,
    base = row.sourceRevision;
  if (
    !base ||
    base.documentId !== receipt.documentId ||
    typeof base.revisionId !== "string" ||
    !base.revisionId ||
    !Number.isSafeInteger(base.version) ||
    base.version < 1 ||
    !/^[a-f0-9]{64}$/.test(base.contentHash)
  )
    throw new DocumentError("sourceUnavailable", 503);
  return row;
}
