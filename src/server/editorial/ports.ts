import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import type {
  EditorialApplicationIntent,
  EditorialProposal,
  EditorialReceipt,
  EditorialSourceRef,
} from "../../shared/editorial/contracts.js";

export interface EditorialSource {
  ref: EditorialSourceRef;
  body: RichDocumentBody;
}
export interface EditorialSources {
  authorize(documentId: string, projectId?: string): (() => void) | Promise<() => void>;
  current(documentId: string, projectId?: string): EditorialSourceRef | Promise<EditorialSourceRef>;
  revision(documentId: string, revisionId: string, projectId?: string): EditorialSource | Promise<EditorialSource>;
  apply(
    intent: EditorialApplicationIntent,
    body: RichDocumentBody,
    completion: EditorialCompletion,
  ): EditorialReceipt | Promise<EditorialReceipt>;
  applied(
    intent: EditorialApplicationIntent,
    body: RichDocumentBody,
  ): AppliedEditorialSource | null | Promise<AppliedEditorialSource | null>;
}
export interface AppliedEditorialSource {
  ref: EditorialSourceRef;
  commit?: string;
}
/** The source adapter chooses its native commit boundary; completion never contains asynchronous IO. */
export interface EditorialCompletion {
  receipt(): EditorialReceipt | null;
  record(applied: AppliedEditorialSource): EditorialReceipt;
}
export interface EditorialProcessor {
  prepare(source: EditorialSource): Pick<EditorialProposal, "producer" | "edits" | "truncated">;
}
