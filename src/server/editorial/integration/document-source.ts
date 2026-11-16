import type { DocumentService } from "../../documents/service.js";
import type { Database } from "bun:sqlite";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { EditorialSources } from "../ports.js";
import { EditorialError } from "../errors.js";
import { editorialSourceError } from "./source-error.js";

const reference = (record: DocumentRecord) => ({
  documentId: record.id,
  revisionId: record.revisionId,
  sourceHash: record.contentHash,
  version: record.revision,
});
/** The document bridge shares the proposal repository's transaction and preserves all non-text source metadata. */
export function documentEditorialSources(documents: DocumentService, db: Database): EditorialSources {
  function access<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      return editorialSourceError(error);
    }
  }
  return {
    authorize: (id, projectId) => {
      if (projectId !== undefined) throw new EditorialError("notFound", 404);
      const assertCurrent = () =>
        access(() => {
          documents.record(id);
        });
      assertCurrent();
      return assertCurrent;
    },
    current: (id, projectId) =>
      access(() => {
        if (projectId !== undefined) throw new EditorialError("notFound", 404);
        return reference(documents.record(id));
      }),
    revision: (id, revisionId, projectId) =>
      access(() => {
        if (projectId !== undefined) throw new EditorialError("notFound", 404);
        documents.record(id);
        const revision = documents.documents.revision(id, revisionId);
        if (!revision.body) throw new EditorialError("unsupportedSource");
        return {
          ref: { documentId: id, revisionId, sourceHash: revision.contentHash, version: revision.number },
          body: revision.body,
        };
      }),
    applied: () => null,
    apply: (intent, body, completion) =>
      access(() =>
        db
          .transaction(() => {
            const receipt = completion.receipt();
            if (receipt) return receipt;
            const base = intent.source;
            const current = documents.detail(base.documentId);
            if (stableJson(reference(current.document)) !== stableJson(base))
              throw new EditorialError("staleSource", 409);
            return completion.record({
              ref: reference(
                documents.saveDocument(base.documentId, {
                  revision: base.version,
                  title: current.revision.title,
                  locale: current.revision.locale,
                  body,
                }).document,
              ),
            });
          })
          .immediate(),
      ),
  };
}
