import { createHash } from "node:crypto";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type { RichDocumentBody } from "../../../shared/documents/rich-body.js";
import type { EditorialApplicationIntent } from "../../../shared/editorial/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { ProjectDocumentQueries } from "../../documents/editor-port.js";
import type { ProjectDocumentChanges } from "../../documents/saved-edits-port.js";
import { richDocumentInput } from "../../documents/rich-codec.js";
import type { EditorialSources } from "../ports.js";
import { EditorialError } from "../errors.js";
import { editorialSourceError } from "./source-error.js";

export function fileDocumentEditorialSources(options: {
  queries: Pick<ProjectDocumentQueries, "record" | "revision">;
  changes: ProjectDocumentChanges;
  requireProject: (projectId: string) => unknown;
}): EditorialSources {
  const scope = (projectId?: string) => {
    if (!projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId)) throw new EditorialError("invalidInput");
    return projectId;
  };
  const ref = (projectId: string, record: DocumentRecord) => ({
    projectId,
    documentId: record.id,
    revisionId: record.revisionId,
    sourceHash: record.contentHash,
    version: record.revision,
  });
  const access = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      return editorialSourceError(error);
    }
  };
  async function edit(intent: EditorialApplicationIntent, body: RichDocumentBody) {
    const projectId = scope(intent.source.projectId),
      original = await options.queries.revision(projectId, intent.source.documentId, intent.source.revisionId);
    if (original.contentHash !== intent.source.sourceHash || original.number !== intent.source.version)
      throw new EditorialError("staleSource", 409);
    const source = richDocumentInput(body);
    return {
      projectId,
      command: {
        operationId: "editorial-" + intent.proposalId,
        expectedRevisionId: intent.source.revisionId,
        expectedVersion: intent.source.version,
        expectedContentHash: intent.source.sourceHash,
        intentHash: createHash("sha256").update(stableJson(intent)).digest("hex"),
        content: {
          title: original.title,
          locale: original.locale,
          content: source.content,
          body: source.body,
          resources: original.resources ?? [],
        },
      },
    };
  }
  return {
    authorize: (id, project) =>
      access(async () => {
        const projectId = scope(project);
        await options.queries.record(projectId, id);
        const assertCurrent = () => {
          try {
            options.requireProject(projectId);
          } catch (error) {
            editorialSourceError(error);
          }
        };
        assertCurrent();
        return assertCurrent;
      }),
    current: (id, project) =>
      access(async () => {
        const projectId = scope(project);
        return ref(projectId, await options.queries.record(projectId, id));
      }),
    revision: (id, revisionId, project) =>
      access(async () => {
        const projectId = scope(project),
          original = await options.queries.revision(projectId, id, revisionId);
        if (!original.body) throw new EditorialError("unsupportedSource");
        return {
          ref: { projectId, documentId: id, revisionId, sourceHash: original.contentHash, version: original.number },
          body: original.body,
        };
      }),
    applied: (intent, body) =>
      access(async () => {
        const { projectId, command } = await edit(intent, body),
          result = await options.changes.receipt(intent.reviewer, projectId, intent.source.documentId, command);
        return result ? { ref: ref(projectId, result.detail.document), commit: result.commit } : null;
      }),
    apply: (intent, body, completion) =>
      access(async () => {
        const receipt = completion.receipt();
        if (receipt) return receipt;
        const { projectId, command } = await edit(intent, body),
          result = await options.changes.apply(intent.reviewer, projectId, intent.source.documentId, command);
        return completion.record({ ref: ref(projectId, result.detail.document), commit: result.commit });
      }),
  };
}
