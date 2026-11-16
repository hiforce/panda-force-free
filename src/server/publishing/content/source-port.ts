import type { ContentSource } from "./source-contract.js";

export type PublicationGuard = () => void | Promise<void>;

/** The publishing domain consumes immutable snapshots through this boundary. */
export interface PublicationSources {
  authorize(documentId: string, projectId?: string): PublicationGuard | Promise<PublicationGuard>;
  current(documentId: string, projectId?: string): { revisionId: string } | Promise<{ revisionId: string }>;
  revision(documentId: string, revisionId: string, projectId?: string): ContentSource | Promise<ContentSource>;
}
export interface PublicationAssets {
  content(
    documentId: string,
    id: string,
    projectId?: string,
  ): Promise<{ name: string; mime: string; digest: string; bytes: Uint8Array }>;
}
