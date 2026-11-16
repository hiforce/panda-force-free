import type { MySQLDocumentService } from "../mysql-service.js";
import type { MySQLDocumentPlacementRepository } from "./mysql-repository.js";
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
export class MySQLDocumentPlacements {
  constructor(
    readonly repository: MySQLDocumentPlacementRepository,
    private documents: MySQLDocumentService,
    private policy: (id: string) => PlacementPolicy | Promise<PlacementPolicy> = () => ({}),
  ) {}
  private async scope(documentId: string, spaceId: string) {
    if (await this.documents.documents.isTrashed(documentId)) throw new DocumentError("notFound", 404);
    const document = await this.documents.documents.record(documentId),
      origin = await this.documents.space(document.spaceId),
      target = await this.documents.space(spaceId);
    if (origin.projectId !== target.projectId) throw new DocumentError("notFound", 404);
    if (origin.id === target.id || (await this.repository.isLibrary(target.id)))
      throw new DocumentError("invalidPlacementTarget");
    return { document, origin, target };
  }
  private async readInput(
    input: Record<string, unknown>,
    scope: Awaited<ReturnType<MySQLDocumentPlacements["scope"]>>,
  ) {
    const path = documentPath(input.path).normalize("NFC"),
      locale = localeText(input.locale),
      revisionId = input.revisionId === null || input.revisionId === undefined ? null : uuid(input.revisionId);
    const revision = await this.documents.documents.revision(
      scope.document.id,
      revisionId ?? scope.document.revisionId,
    );
    if (!compatiblePlacementLocale(revision.locale, locale)) throw new DocumentError("placementLocaleMismatch", 409);
    const policy = await this.policy(scope.target.id);
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
  async resolve(placement: DocumentPlacement) {
    if (placement.deletedAt !== null) throw new DocumentError("notFound", 404);
    const scope = await this.scope(placement.documentId, placement.spaceId),
      { revision } = await this.readInput({ ...placement }, scope);
    return { document: scope.document, revision, engine: scope.origin.engine };
  }
  private async authorize(record: DocumentPlacement) {
    const space = await this.documents.space(record.spaceId);
    if (space.projectId !== record.projectId) throw new DocumentError("notFound", 404);
    return record;
  }
  async get(id: string) {
    return await this.authorize(await this.repository.get(text(id, 128)));
  }
  async listForDocument(id: string) {
    const source = await this.documents.detail(text(id, 128));
    return await Promise.all(
      (await this.repository.list("documentId", source.document.id)).map(async (value) => await this.authorize(value)),
    );
  }
  async listForSpace(id: string) {
    const space = await this.documents.space(text(id, 128));
    return await Promise.all(
      (await this.repository.list("spaceId", space.id)).map(async (value) => await this.authorize(value)),
    );
  }
  async create(input: Record<string, unknown>, actor: string) {
    return await this.repository.atomic(async () => {
      const id = uuid(input.id),
        documentId = uuid(input.documentId),
        spaceId = uuid(input.spaceId),
        scope = await this.scope(documentId, spaceId),
        { fields } = await this.readInput(input, scope),
        existing = await this.repository.find(id);
      if (existing) {
        await this.authorize(existing);
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
      return await this.repository.insert(
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
  async update(id: string, input: Record<string, unknown>, actor: string) {
    return await this.repository.atomic(async () => {
      const existing = await this.get(id),
        scope = await this.scope(existing.documentId, existing.spaceId),
        { fields } = await this.readInput(input, scope);
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
      return await this.repository.update({ ...existing, ...fields }, expected, text(actor, 200));
    });
  }
  async remove(id: string, version: unknown, actor: string) {
    return await this.repository.atomic(async () => {
      await this.get(id);
      return await this.repository.remove(id, expectedVersion(version), text(actor, 200));
    });
  }
  async history(id: string) {
    await this.get(id);
    return await this.repository.history(id);
  }
}
