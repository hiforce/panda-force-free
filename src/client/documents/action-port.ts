import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { DocumentPublicationScope } from "./publication/port.js";
import type { DocumentSourceActionResult } from "../../shared/documents/action-result.js";
export interface DocumentPublicationActions {
  open(
    document: DocumentRecord,
    options?: { richtext?: boolean; scope?: DocumentPublicationScope },
  ): Promise<DocumentSourceActionResult | null>;
  close(): void;
}
