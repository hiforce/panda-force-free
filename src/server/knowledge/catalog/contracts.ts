import type {
  KnowledgeCatalogEntry,
  KnowledgeCatalogProjection,
  KnowledgeAdmission,
  KnowledgeReadScope,
  ApprovedKnowledgeValue,
} from "../../../shared/knowledge/catalog.js";
export type {
  KnowledgeCatalogEntry,
  KnowledgeCatalogProjection,
  KnowledgeAdmission,
  KnowledgeReadScope,
  ApprovedKnowledgeValue,
} from "../../../shared/knowledge/catalog.js";
export interface ApprovedKnowledgeReader {
  head(scope: KnowledgeReadScope): Promise<string>;
  snapshot(scope: KnowledgeReadScope): Promise<{ commit: string; records: ApprovedKnowledgeValue[] }>;
  /** One scoped file read validates current permissions, saved bindings and evidence before returning any record. */
  current(scope: KnowledgeReadScope, ids: readonly string[]): Promise<ApprovedKnowledgeValue[]>;
}
export interface KnowledgeCatalog {
  lookup(owner: string, project: string, taskIds: readonly string[]): KnowledgeCatalogSelection;
  page(
    owner: string,
    project: string,
    after?: string,
    limit?: number,
  ): KnowledgeCatalogSelection & { next: string | null; scanned: number };
  list(
    owner: string,
    project: string,
  ): { entries: KnowledgeCatalogEntry[]; incomplete: boolean; missing: KnowledgeAdmission[] };
  candidates(
    after: string,
    onlyMissing?: boolean,
  ): { admissions: KnowledgeAdmission[]; invalid: number; cursor: string };
  current(admission: KnowledgeAdmission): KnowledgeCatalogEntry | null;
  save(admission: KnowledgeAdmission, projection: KnowledgeCatalogProjection): boolean;
}
export interface KnowledgeCatalogSelection {
  entries: KnowledgeCatalogEntry[];
  incomplete: boolean;
  missing: KnowledgeAdmission[];
}
