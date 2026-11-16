/** Portable records shared by document applications, adapters and browser views. */
export type DocumentEngine = "markdown" | "hexo" | "docusaurus";
export type SourceMode = "managed" | "external";
import type { RichDocumentBody } from "./rich-body.js";
export interface DocumentSpace {
  id: string;
  projectId: string;
  code: string;
  name: string;
  engine: DocumentEngine;
  theme: string;
  sourceMode: SourceMode;
  sourceRoot: string;
  locale: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface DocumentRecord {
  id: string;
  spaceId: string;
  path: string;
  title: string;
  locale: string;
  revision: number;
  revisionId: string;
  contentHash: string;
  importedHash: string | null;
  importedRevision: number | null;
  updatedAt: number;
}
export interface DocumentResourceBinding {
  source: string;
  sourcePath: string;
  assetId: string;
  digest: string;
}
export interface DocumentImportIssue {
  path: string;
  source: string;
  code: "imageExternal" | "imageUnsupported" | "imageUnavailable" | "imageMissing" | "imageAmbiguous" | "imageLimit";
}
export interface DocumentRevision {
  id: string;
  documentId: string;
  resources?: DocumentResourceBinding[];
  number: number;
  title: string;
  locale: string;
  content: string;
  body?: RichDocumentBody;
  contentHash: string;
  createdAt: number;
}
export interface DocumentDetail {
  sourceMode?: SourceMode;
  engine?: DocumentEngine;
  document: DocumentRecord;
  revision: DocumentRevision;
}
export interface DocumentPage {
  documents: DocumentRecord[];
  total: number;
  nextOffset: number | null;
}
export interface DocumentFolder {
  id: string;
  spaceId: string;
  path: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface SourceDocument {
  path: string;
  title: string;
  locale: string;
  content: string;
  hash: string;
}
export interface ImportResult {
  assets?: { imported: number; updatedDocuments: number; issues: DocumentImportIssue[]; issuesTruncated?: boolean };
  created: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  skipped: string[];
  truncated: boolean;
}
export interface SourceInspection {
  root: string;
  engine: DocumentEngine;
  detectedVersion: string | null;
  sourceDirectories: string[];
  warnings: string[];
}
export interface DocumentSpaceInput {
  projectId: string;
  code: string;
  name: string;
  engine: DocumentEngine;
  sourceMode: SourceMode;
  sourceRoot?: string;
  locale: string;
  theme: string;
}

export interface DocumentAsset {
  id: string;
  documentId: string;
  name: string;
  mime: string;
  digest: string;
  size: number;
  width: number;
  height: number;
  alt: string;
  createdAt: number;
}

export interface DocumentAssetImportResult {
  detail: DocumentDetail;
  imported: number;
  changed: boolean;
  issues: DocumentImportIssue[];
}
