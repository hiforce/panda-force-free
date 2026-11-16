import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { MySQLDocumentService } from "../../documents/mysql-service.js";
import type { MySQLDocumentSession } from "../../documents/mysql-session.js";
import type { MySQLEditorialSession } from "../mysql-session.js";
import type { AsyncEditorialSources } from "../async-ports.js";
import { EditorialError } from "../errors.js";
import { editorialSourceError } from "./source-error.js";
const reference = (record: DocumentRecord) => ({
  documentId: record.id,
  revisionId: record.revisionId,
  sourceHash: record.contentHash,
  version: record.revision,
});
/** Relational legacy documents and editorial receipts commit on one connection; native file/Git sources retain their separate adapter. */
export function mysqlDocumentEditorialSources(
  documents: MySQLDocumentService,
  documentSession: MySQLDocumentSession,
  editorialSession: MySQLEditorialSession,
): AsyncEditorialSources {
  const access = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      return editorialSourceError(error);
    }
  };
  const unscoped = (projectId?: string) => {
    if (projectId !== undefined) throw new EditorialError("notFound", 404);
  };
  return {
    authorize: async (id, projectId) => {
      unscoped(projectId);
      const assertCurrent = async () => {
        await access(() => documents.record(id));
      };
      await assertCurrent();
      return assertCurrent;
    },
    current: (id, projectId) =>
      access(async () => {
        unscoped(projectId);
        return reference(await documents.record(id));
      }),
    revision: (id, revisionId, projectId) =>
      access(async () => {
        unscoped(projectId);
        await documents.record(id);
        const revision = await documents.documents.revision(id, revisionId);
        if (!revision.body) throw new EditorialError("unsupportedSource");
        return {
          ref: { documentId: id, revisionId, sourceHash: revision.contentHash, version: revision.number },
          body: revision.body,
        };
      }),
    applied: async () => null,
    apply: (intent, body, completion) =>
      access(() =>
        documentSession.transactionConnection(async (sql) => {
          await editorialSession.lockConnection(sql);
          return editorialSession.withinConnection(sql, async () => {
            const previous = await completion.receipt();
            if (previous) return previous;
            const current = await documents.detail(intent.source.documentId);
            if (stableJson(reference(current.document)) !== stableJson(intent.source))
              throw new EditorialError("staleSource", 409);
            const saved = await documents.saveDocument(intent.source.documentId, {
              revision: intent.source.version,
              title: current.revision.title,
              locale: current.revision.locale,
              body,
            });
            return completion.record({ ref: reference(saved.document) });
          });
        }),
      ),
  };
}
