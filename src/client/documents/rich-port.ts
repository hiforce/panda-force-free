import type { Translate } from "../../shared/i18n/messages.js";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import type { DocumentAsset } from "../../shared/documents/contracts.js";

export interface RichEditorOptions {
  body: RichDocumentBody;
  imageUrl?(id: string): string;
  toolbarHost?: HTMLElement;
  editable: boolean;
  t: Translate;
  changed(): void;
  error(error: unknown): void;
  upload(file: File): Promise<DocumentAsset>;
  link(current: string): Promise<string | null>;
}
export interface RichEditorPort {
  snapshot(): { body: RichDocumentBody; content: string };
  readonly uploading: boolean;
  setEditable(editable: boolean): void;
  insertMarkdown(markdown: string): void;
  focus(scrollIntoView?: boolean): void;
  openInsertMenu(anchor: HTMLElement): void;
  destroy(): void;
}
export interface RichRuntimePort {
  createRichDocumentEditor(host: HTMLElement, options: RichEditorOptions): RichEditorPort;
}
