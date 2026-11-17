import type { DocumentRevision } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

export type DocumentHistorySummary = Pick<
  DocumentRevision,
  "id" | "documentId" | "number" | "title" | "locale" | "contentHash" | "createdAt"
>;
export function documentHistoryPage(beforeVersion: number, limit: number) {
  if (
    !Number.isSafeInteger(beforeVersion) ||
    beforeVersion < 2 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new DocumentError("invalidInput");
}
export function documentHistoryCursor(revisions: readonly DocumentHistorySummary[], limit: number) {
  const last = revisions.at(-1);
  return revisions.length === limit && last && last.number > 1 ? last.number : null;
}
