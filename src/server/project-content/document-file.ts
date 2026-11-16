import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { createHash } from "node:crypto";
import type { DocumentDetail } from "../../shared/documents/contracts.js";
import { documentContentIdentity } from "../../shared/documents/content-identity.js";
import { normalizeRichBody } from "../../shared/documents/rich-body.js";
import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { projectContentId } from "./paths.js";
import { decodeProjectDocumentRecord } from "./document-record.js";
import {
  fileRecord as record,
  fileText as text,
  fileInteger as integer,
  fileDigest as digest,
  fileLocale as locale,
} from "./codec-values.js";

const revisionKeys = [
  "id",
  "documentId",
  "number",
  "title",
  "locale",
  "content",
  "body",
  "contentHash",
  "createdAt",
  "resources",
];
/** The file is authoritative; its Markdown projection is preserved verbatim, including historical rich projections. */
function validateDocument(value: unknown): DocumentDetail {
  const envelope = record(value, ["schema", "document", "revision"]);
  if (envelope.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const document = decodeProjectDocumentRecord(envelope.document),
    r = record(envelope.revision, revisionKeys);
  const revision: DocumentDetail["revision"] = {
    id: projectContentId(r.id),
    documentId: projectContentId(r.documentId),
    number: integer(r.number, 1),
    title: text(r.title, 2000),
    locale: locale(r.locale),
    content: text(r.content, 2 * 1024 * 1024, true),
    contentHash: digest(r.contentHash),
    createdAt: integer(r.createdAt),
  };
  if (r.body !== undefined) {
    try {
      normalizeRichBody(r.body);
      // Validation must not silently rewrite previously committed structured source.
      revision.body = structuredClone(r.body) as NonNullable<typeof revision.body>;
    } catch {
      throw new ProjectContentError("invalidFile");
    }
  }
  if (r.resources !== undefined) {
    if (!Array.isArray(r.resources) || r.resources.length > 1000) throw new ProjectContentError("invalidFile");
    const sources = new Set<string>();
    revision.resources = r.resources.map((value) => {
      const resource = record(value, ["source", "sourcePath", "assetId", "digest"]);
      const source = text(resource.source, 4096);
      if (sources.has(source)) throw new ProjectContentError("invalidFile");
      sources.add(source);
      return {
        source,
        sourcePath: text(resource.sourcePath, 4096),
        assetId: projectContentId(resource.assetId),
        digest: digest(resource.digest),
      };
    });
  }
  const actual = createHash("sha256").update(documentContentIdentity(revision.content, revision.body)).digest("hex");
  if (
    document.id !== revision.documentId ||
    document.revisionId !== revision.id ||
    document.revision !== revision.number ||
    document.title !== revision.title ||
    document.locale !== revision.locale ||
    document.contentHash !== actual ||
    revision.contentHash !== actual
  )
    throw new ProjectContentError("invalidFile");
  return { document, revision };
}

export function encodeProjectDocument(detail: DocumentDetail): string {
  const envelope = { schema: 1, document: detail.document, revision: detail.revision };
  validateDocument(envelope);
  const result = JSON.stringify(JSON.parse(stableJson(envelope)), null, 2) + "\n";
  if (Buffer.byteLength(result) > PROJECT_CONTENT_LIMITS.fileBytes) throw new ProjectContentError("invalidFile");
  return result;
}

export function decodeProjectDocument(input: Uint8Array | string): DocumentDetail {
  if (Buffer.byteLength(input) > PROJECT_CONTENT_LIMITS.fileBytes) throw new ProjectContentError("invalidFile");
  try {
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    return validateDocument(JSON.parse(text));
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}
