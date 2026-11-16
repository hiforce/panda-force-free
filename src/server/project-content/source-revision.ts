import { createHash, randomUUID } from "node:crypto";
import type { DocumentDetail } from "../../shared/documents/contracts.js";
import { documentContentIdentity } from "../../shared/documents/content-identity.js";
import type { ProjectDraftContent } from "./drafts/content.js";

/** Callers validate ownership, resource references and concurrency before creating a new immutable revision. */
export function nextSourceRevision(current: DocumentDetail, content: ProjectDraftContent): DocumentDetail {
  const id = randomUUID(),
    number = current.document.revision + 1,
    now = Math.max(Date.now(), current.document.updatedAt),
    contentHash = createHash("sha256").update(documentContentIdentity(content.content, content.body)).digest("hex");
  return {
    document: {
      ...current.document,
      title: content.title,
      locale: content.locale,
      revision: number,
      revisionId: id,
      contentHash,
      updatedAt: now,
    },
    revision: { ...content, id, documentId: current.document.id, number, contentHash, createdAt: now },
  };
}
