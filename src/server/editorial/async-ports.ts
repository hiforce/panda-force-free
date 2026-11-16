import type { EditorialApplicationIntent, EditorialReceipt } from "../../shared/editorial/contracts.js";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import type { EditorialSources, AppliedEditorialSource } from "./ports.js";
export type { EditorialProcessor, EditorialSource, AppliedEditorialSource } from "./ports.js";
/** Native file/Git adapters await metadata completion after their own durable write boundary. */
export interface AsyncEditorialCompletion {
  receipt(): Promise<EditorialReceipt | null>;
  record(applied: AppliedEditorialSource): Promise<EditorialReceipt>;
}
export interface AsyncEditorialSources extends Omit<EditorialSources, "apply" | "authorize"> {
  authorize(documentId: string, projectId?: string): Promise<() => void | Promise<void>>;
  apply(
    intent: EditorialApplicationIntent,
    body: RichDocumentBody,
    completion: AsyncEditorialCompletion,
  ): Promise<EditorialReceipt>;
}
