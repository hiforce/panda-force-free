import { createHash } from "node:crypto";
import type { DocumentDetail } from "../../src/shared/documents/contracts.js";

export function projectDocumentFixture(number = 1, id = "doc-1", content = "Exact source\r\n"): DocumentDetail {
  const hash = createHash("sha256").update(content).digest("hex"),
    revisionId = id + "-rev-" + number,
    title = "Document " + id;
  return {
    document: {
      id,
      spaceId: "space-1",
      path: id + ".md",
      title,
      locale: "en",
      revision: number,
      revisionId,
      contentHash: hash,
      importedHash: null,
      importedRevision: null,
      updatedAt: 123400 + number,
    },
    revision: {
      id: revisionId,
      documentId: id,
      number,
      title,
      locale: "en",
      content,
      contentHash: hash,
      createdAt: 123400 + number,
    },
  };
}
