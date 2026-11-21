import type {
  DocumentAsset,
  DocumentAssetImportResult,
  DocumentDetail,
  DocumentEngine,
  DocumentPage,
  DocumentRecord,
  DocumentRevision,
  DocumentSpace,
  ImportResult,
  SourceInspection,
} from "../../shared/documents/contracts.js";
import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import type {
  SiteSourceProfile,
  SourceConfigurationOptions,
  SourceConfigurationProposal,
} from "../../shared/sites/profile.js";

export interface DocumentQueries {
  space(id: string): Promise<DocumentSpace>;
  listSpaces(project: string): Promise<DocumentSpace[]>;
  detail(id: string): Promise<DocumentDetail>;
  listDocuments(space: string, search: string, offset: number): Promise<DocumentPage>;
  inspectSource(path: string): Promise<SourceInspection>;
  themes(engine: DocumentEngine): Promise<{
    themes: SiteThemeDescriptor[];
    defaults: { hexo: string; docusaurus: string };
  }>;
  history(id: string, revision?: string | null): Promise<
    { revision: DocumentRevision } | { revisions: Omit<DocumentRevision, "content">[] }
  >;
}
export interface DocumentCommands {
  createSpace(value: unknown): Promise<DocumentSpace>;
  updateTheme(id: string, value: Record<string, unknown>): Promise<DocumentSpace>;
  importSource(id: string): Promise<ImportResult>;
  importImages(id: string, revision: number): Promise<DocumentAssetImportResult>;
  createDocument(value: Record<string, unknown>): Promise<DocumentDetail>;
  saveDocument(id: string, value: Record<string, unknown>): Promise<DocumentDetail>;
}
export interface DocumentAssetOperations {
  list(id: string): Promise<DocumentAsset[]>;
  upload(id: string, name: string, bytes: Buffer): Promise<DocumentAsset>;
  content(id: string): Promise<{ asset: DocumentAsset; bytes: Uint8Array }>;
}
export interface DocumentLanguageOperations {
  list(id: string): Promise<DocumentRecord[]>;
  link(id: string, other: string): Promise<DocumentRecord[]>;
  unlink(id: string): Promise<DocumentRecord[]>;
}
export interface DocumentProfileOperations {
  get(id: string): Promise<SiteSourceProfile | null>;
  save(id: string, value: unknown, version: unknown): Promise<DocumentSpace>;
  options(id: string): Promise<SourceConfigurationOptions>;
  inspect(id: string, locale: string, files: string[], webp: boolean): Promise<SourceConfigurationProposal>;
}
/** HTTP consumers await application operations and never reach into a concrete repository. */
export interface DocumentApplicationPort {
  queries: DocumentQueries;
  commands: DocumentCommands;
  assets: DocumentAssetOperations;
  languages: DocumentLanguageOperations;
  profiles?: DocumentProfileOperations;
}

/** Only adapter inputs accept native synchronous operations; public application ports always await. */
export type AwaitableOperations<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaited<R> | Promise<Awaited<R>>
    : never;
};
