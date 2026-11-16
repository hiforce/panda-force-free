import type { DocumentResourceBinding } from "../../../shared/documents/contracts.js";
import type { RichDocumentBody } from "../../../shared/documents/rich-body.js";
import type { ContentSourceScope } from "../../../shared/publishing/source-scope.js";

/** Authorized immutable source data; storage, editor runtimes and platform DTOs stay outside this contract. */
export interface ContentSource extends ContentSourceScope {
  body?: RichDocumentBody;
  resources?: DocumentResourceBinding[];
  documentId: string;
  revisionId: string;
  title: string;
  locale: string;
  content: string;
  engine: "markdown" | "hexo" | "docusaurus";
}
