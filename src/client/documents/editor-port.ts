import type { DocumentRecord } from "../../shared/documents/contracts.js";

/** Workspace coordination depends on editor behavior, independently of legacy or file persistence. */
export interface DocumentEditorPort {
  readonly id: string;
  readonly record: DocumentRecord | null;
  readonly changed: boolean;
  readonly saving: boolean;
  readonly editing: boolean;
  mount(host: HTMLElement): void;
  detach(): void;
  select(id: string, spaceId?: string): Promise<void>;
  beginEditing(): void;
  acceptRename(record: DocumentRecord): boolean;
  flush(): void;
}
