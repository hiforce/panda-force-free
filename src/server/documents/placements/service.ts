import type { DocumentService } from "../service.js";
import type { DocumentPlacementRepository } from "./repository.js";
import type { DocumentPlacement } from "../../../shared/documents/placements.js";
import { publicDocumentMetadata } from "../../../shared/sites/metadata.js";
import { SiteProfileError } from "../../../shared/sites/config.js";
import { documentPath, expectedVersion, localeText, text } from "../validation.js";
import { DocumentError } from "../errors.js";
import { stableJson } from "../../../shared/stable-json.js";
import { compatibleDocumentLocale } from "../../../shared/documents/locales.js";

export interface PlacementPolicy {
  locales?: string[];
  metadataFields?: string[];
}
export const compatiblePlacementLocale = compatibleDocumentLocale;
const uuid = (value: unknown) => {
  const id = text(value, 36);
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new DocumentError("invalidInput");
  return id;
};
/** A placement selects saved content and a destination; it never edits the source or authorizes publication. */
export class DocumentPlacements {
  constructor(
    readonly repository: DocumentPlacementRepository,
    private documents: DocumentService,
    private policy: (id: string) => PlacementPolicy = () => ({}),
  ) {}
  private scope(documentId: string, spaceId: string) {
    if (this.documents.documents.isTrashed(documentId)) throw new DocumentError("notFound", 404);
    const document = this.documents.documents.record(documentId),
      origin = this.documents.space(document.spaceId),
      target = this.documents.space(spaceId);
    if (origin.projectId !== target.projectId) throw new DocumentError("notFound", 404);
    if (origin.id === target.id || this.repository.isLibrary(target.id))
      throw new DocumentError("invalidPlacementTarget");
    return { document, origin, target };
  }
  private readInput(input: Record<string, unknown>, scope: ReturnType<DocumentPlacements["scope"]>) {
    const path = documentPath(input.path).normalize("NFC"),
      locale = localeText(input.locale),
      revisionId = input.revisionId === null || input.revisionId === undefined ? null : uuid(input.revisionId);
    const revision = this.documents.documents.revision(scope.document.id, revisionId ?? scope.document.revisionId);
    if (!compatiblePlacementLocale(revision.locale, locale)) throw new DocumentError("placementLocaleMismatch", 409);
    const policy = this.policy(scope.target.id);
    if (policy.locales && !policy.locales.some((value) => value.toLowerCase() === locale.toLowerCase()))
      throw new DocumentError("sourceEditionMissing");
    try {
      return {
        fields: {
          path,
          locale,
          revisionId,
          metadata: publicDocumentMetadata(input.metadata ?? {}, policy.metadataFields),
        },
        revision,
      };
    } catch (error) {
      if (error instanceof SiteProfileError) throw new DocumentError("invalidPlacementMetadata");
      throw error;
    }
  }
  /** Resolve a saved reference inside the caller's snapshot transaction, rechecking current access and policy. */
  resolve(placement: DocumentPlacement) {
    if (placement.deletedAt !== null) throw new DocumentError("notFound", 404);
    const scope = this.scope(placement.documentId, placement.spaceId),
      { revision } = this.readInput({ ...placement }, scope);
    return { document: scope.document, revision, engine: scope.origin.engine };
  }
  private authorize(record: DocumentPlacement) {
    const space = this.documents.space(record.spaceId);
    if (space.projectId !== record.projectId) throw new DocumentError("notFound", 404);
    return record;
  }
  get(id: string) {
    return this.authorize(this.repository.get(text(id, 128)));
  }
  listForDocument(id: string) {
    const source = this.documents.detail(text(id, 128));
    return this.repository.list("documentId", source.document.id).map((value) => this.authorize(value));
  }
  listForSpace(id: string) {
    const space = this.documents.space(text(id, 128));
    return this.repository.list("spaceId", space.id).map((value) => this.authorize(value));
  }
  create(input: Record<string, unknown>, actor: string) {
    return this.repository.atomic(() => {
      const id = uuid(input.id),
        documentId = uuid(input.documentId),
        spaceId = uuid(input.spaceId),
        scope = this.scope(documentId, spaceId),
        { fields } = this.readInput(input, scope),
        existing = this.repository.find(id);
      if (existing) {
        this.authorize(existing);
        if (
          existing.deletedAt === null &&
          existing.documentId === documentId &&
          existing.spaceId === spaceId &&
          stableJson({
            path: existing.path,
            locale: existing.locale,
            revisionId: existing.revisionId,
            metadata: existing.metadata,
          }) === stableJson(fields)
        )
          return existing;
        throw new DocumentError("conflict", 409);
      }
      if (input.spaceVersion !== undefined && expectedVersion(input.spaceVersion) !== scope.target.version)
        throw new DocumentError("spaceConflict", 409);
      const now = Date.now();
      return this.repository.insert(
        {
          id,
          projectId: scope.target.projectId,
          documentId,
          spaceId,
          ...fields,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        text(actor, 200),
      );
    });
  }
  update(id: string, input: Record<string, unknown>, actor: string) {
    return this.repository.atomic(() => {
      const existing = this.get(id),
        scope = this.scope(existing.documentId, existing.spaceId),
        { fields } = this.readInput(input, scope);
      if (
        (input.documentId !== undefined && input.documentId !== existing.documentId) ||
        (input.spaceId !== undefined && input.spaceId !== existing.spaceId)
      )
        throw new DocumentError("invalidInput");
      const expected = expectedVersion(input.version);
      const same =
        stableJson({
          path: existing.path,
          locale: existing.locale,
          revisionId: existing.revisionId,
          metadata: existing.metadata,
        }) === stableJson(fields);
      if (existing.deletedAt === null && existing.version === expected + 1 && same) return existing;
      if (input.spaceVersion !== undefined && expectedVersion(input.spaceVersion) !== scope.target.version)
        throw new DocumentError("spaceConflict", 409);
      return this.repository.update({ ...existing, ...fields }, expected, text(actor, 200));
    });
  }
  remove(id: string, version: unknown, actor: string) {
    return this.repository.atomic(() => {
      this.get(id);
      return this.repository.remove(id, expectedVersion(version), text(actor, 200));
    });
  }
  history(id: string) {
    this.get(id);
    return this.repository.history(id);
  }
}
