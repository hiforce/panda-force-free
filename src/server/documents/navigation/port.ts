import type {
  DocumentTreeMutation,
  DocumentTreeTrashPage,
  ProjectDocumentTree,
} from "../../../shared/documents/navigation.js";

/** Both browser menus and agent tools await the same project-scoped document operations. */
export interface DocumentNavigationPort {
  tree(projectId: string): Promise<ProjectDocumentTree>;
  trashPage(projectId: string, cursor?: string): Promise<DocumentTreeTrashPage>;
  create(actor: string, input: unknown): Promise<DocumentTreeMutation>;
  move(actor: string, input: unknown): Promise<DocumentTreeMutation>;
  rename(actor: string, input: unknown): Promise<DocumentTreeMutation>;
  trash(actor: string, input: unknown): Promise<DocumentTreeMutation>;
  restore(actor: string, input: unknown): Promise<DocumentTreeMutation>;
}
