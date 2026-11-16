import { createHash } from "node:crypto";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import { documentContentIdentity } from "../../shared/documents/content-identity.js";
export const contentHash = (content: string, body?: RichDocumentBody) =>
  createHash("sha256").update(documentContentIdentity(content, body)).digest("hex");
