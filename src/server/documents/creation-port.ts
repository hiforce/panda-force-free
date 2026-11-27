import type { RichDocumentBody } from "../../shared/documents/rich-body.js";

export interface PreparedDocumentCreation {
  copiedFrom?: { scope: "personal"; documentId: string; revisionId: string };
  body: RichDocumentBody;
  images: readonly { id: string; name: string; bytes: Uint8Array }[];
}
/** Trusted producers supply immutable intent; project creation resolves it only after checking its durable receipt. */
export interface DocumentCreationSource {
  readonly identity: string;
  verify?(): Promise<void>;
  prepare(): Promise<PreparedDocumentCreation>;
}
