import { createHash } from "node:crypto";
import type { DocumentDetail, DocumentFolder, DocumentSpace } from "../../../shared/documents/contracts.js";
import { emptyRichBody } from "../../../shared/documents/rich-body.js";
import { documentContentIdentity } from "../../../shared/documents/content-identity.js";
import { contentRequestHash } from "../mutation.js";
import { encodeProjectDocument } from "../document-file.js";

function title(value: string) {
  let output = "";
  for (const part of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)) {
    if (output.length + part.segment.length > 200) break;
    output += part.segment;
  }
  return output.trim() || "Document";
}
/** Conversion identity is independent of retry time, backup bytes or a chosen storage root. */
export function legacyDirectoryDocument(space: DocumentSpace, path: string, folder?: DocumentFolder): DocumentDetail {
  const key = contentRequestHash({ projectId: space.projectId, spaceId: space.id, path }),
    id = "directory-" + key,
    revisionId = "directory-revision-" + key,
    createdAt = folder?.createdAt ?? space.createdAt,
    updatedAt = folder?.updatedAt ?? space.createdAt,
    heading = title(path.split("/").at(-1)!),
    body = emptyRichBody(),
    content = "",
    contentHash = createHash("sha256").update(documentContentIdentity(content, body)).digest("hex"),
    detail: DocumentDetail = {
      document: {
        id,
        spaceId: space.id,
        path: id + ".md",
        title: heading,
        locale: space.locale,
        revision: 1,
        revisionId,
        contentHash,
        importedHash: null,
        importedRevision: null,
        updatedAt,
      },
      revision: {
        id: revisionId,
        documentId: id,
        number: 1,
        title: heading,
        locale: space.locale,
        content,
        body,
        contentHash,
        createdAt,
        resources: [],
      },
    };
  encodeProjectDocument(detail);
  return detail;
}
