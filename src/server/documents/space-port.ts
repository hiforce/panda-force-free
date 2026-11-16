import type { DocumentSpace, SourceInspection } from "../../shared/documents/contracts.js";
import type { SiteSourceProfile } from "../../shared/sites/profile.js";

export interface DocumentSpaceConfiguration {
  space: DocumentSpace;
  profile: SiteSourceProfile | null;
}
export interface ProjectDocumentSpaces {
  list(projectId: string): Promise<DocumentSpace[]>;
  get(projectId: string, spaceId: string): Promise<DocumentSpaceConfiguration>;
  create(actor: string, value: unknown): Promise<DocumentSpace>;
  configure(actor: string, projectId: string, spaceId: string, value: unknown): Promise<DocumentSpaceConfiguration>;
  inspect(projectId: string, value: unknown): Promise<SourceInspection>;
}
