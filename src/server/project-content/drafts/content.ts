import type { DocumentDetail, DocumentRevision } from "../../../shared/documents/contracts.js";
import type { DocumentWorkingContent } from "../../../shared/documents/working-copy.js";
import { documentContentIdentity } from "../../../shared/documents/content-identity.js";
import { createHash } from "node:crypto";
import { decodeProjectDocument } from "../document-file.js";
import { fileRecord } from "../codec-values.js";
import { ProjectContentError } from "../errors.js";

export type ProjectDraftContent = DocumentWorkingContent;

/** Drafts and saved originals use the same source/body/resource validation without inventing a saved revision. */
export function draftContent(input: unknown): ProjectDraftContent {
  try {
    const v = fileRecord(input, ["title", "locale", "content", "body", "resources"]),
      contentHash = createHash("sha256")
        .update(documentContentIdentity(v.content as string, v.body as DocumentRevision["body"]))
        .digest("hex"),
      detail = decodeProjectDocument(
        JSON.stringify({
          schema: 1,
          document: {
            id: "draft",
            spaceId: "space",
            path: "draft.md",
            title: v.title,
            locale: v.locale,
            revision: 1,
            revisionId: "draft",
            contentHash,
            importedHash: null,
            importedRevision: null,
            updatedAt: 0,
          },
          revision: { ...v, id: "draft", documentId: "draft", number: 1, contentHash, createdAt: 0 },
        }),
      ),
      { title, locale, content, body, resources } = detail.revision;
    return { title, locale, content, ...(body === undefined ? {} : { body }), resources: resources ?? [] };
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}
export function currentDraftContent(detail: DocumentDetail): ProjectDraftContent {
  const { title, locale, content, body, resources } = detail.revision;
  return draftContent({ title, locale, content, ...(body === undefined ? {} : { body }), resources: resources ?? [] });
}
