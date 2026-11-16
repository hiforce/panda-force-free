import type {
  DocumentEngine,
  DocumentRecord,
  DocumentRevision,
  DocumentSpace,
} from "../../shared/documents/contracts.js";
import type { PublicDocumentMetadata } from "../../shared/sites/metadata.js";
import type { SiteSourceProfile } from "../../shared/sites/profile.js";

/** Destination coordinates and source identity are independent; all selected bodies are saved immutable originals. */
export interface SpaceDocumentSelection {
  document: DocumentRecord;
  revision: DocumentRevision;
  engine: DocumentEngine;
  path: string;
  locale: string;
  metadata?: PublicDocumentMetadata;
  placement?: { id: string; version: number };
}
export interface DocumentSpaceSnapshot {
  space: DocumentSpace;
  documents: SpaceDocumentSelection[];
}
export interface ProjectDocumentSpaceSnapshot extends DocumentSpaceSnapshot {
  projectId: string;
  commit: string;
  profile: SiteSourceProfile | null;
}
export interface ProjectDocumentSnapshots {
  capture(
    projectId: string,
    spaceId: string,
    locale: string,
    limits: { documents: number; bytes: number },
    expectedSpaceVersion?: number,
  ): Promise<ProjectDocumentSpaceSnapshot>;
}
