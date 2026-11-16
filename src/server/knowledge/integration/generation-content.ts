import type { FileOriginalQueries } from "../../content-sources/reader.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import type { ProjectContentProject } from "../../project-content/project.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import type {
  KnowledgeGenerationSource,
  KnowledgeGenerationCatalog,
  GenerationSnapshot,
  GenerationReadScope,
} from "../generation/contracts.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { GENERATION_LIMITS, type KnowledgeGenerationSourcePage } from "../../../shared/knowledge/generation.js";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { savedKnowledgeDocuments } from "./saved-documents.js";

/** Tracked file identities and navigation are sufficient for rules; discovery never downloads or decodes document bodies. */
export function fileKnowledgeGenerationSource(
  projects: (owner: string, project: string) => Promise<DocumentProjectReads>,
  initialize?: (owner: string, project: string) => Promise<void>,
  originals?: (owner: string, project: string) => Promise<FileOriginalQueries>,
): KnowledgeGenerationSource & KnowledgeGenerationCatalog {
  const read = async <T>(
    owner: string,
    project: string,
    work: (project: ProjectContentProject, view: ProjectContentView) => Promise<T>,
  ) => {
    const files = await projects(owner, project);
    await files.authorize(project);
    const result = await files.ifPresent(project, work);
    await files.authorize(project);
    return result;
  };
  const originalReader = async (owner: string, project: string, scope?: GenerationReadScope) => {
    if (!scope?.originals.length) return null;
    if (!originals) throw new KnowledgeTaskError("unavailable");
    return originals(owner, project);
  };
  const metadata = async (
    owned: ProjectContentProject,
    view: ProjectContentView,
    project: string,
    reader: FileOriginalQueries | null,
    scope?: GenerationReadScope,
  ): Promise<GenerationSnapshot> => {
    const saved = scope?.documents === false ? null : await savedKnowledgeDocuments(view, project),
      native =
        reader && scope?.originals.length ? await reader.saved(view, owned.owned, project, scope.originals) : null;
    return {
      commit: view.commit,
      documents: [...(saved?.documents.values() ?? [])].map(({ id, parentId, version }) => ({ id, parentId, version })),
      ...(scope?.originals.length
        ? {
            originals: (native?.entries ?? []).map((row) => {
              if (row.binding.kind === "document") throw new KnowledgeTaskError("conflict");
              return { id: row.id, kind: row.binding.kind, version: row.binding.blob };
            }),
          }
        : {}),
    };
  };
  const baseline = async <T>(
    owner: string,
    project: string,
    expected: string | undefined,
    work: (snapshot: GenerationSnapshot, assertHeld: () => void) => T,
    scope?: GenerationReadScope,
  ) => {
    const reader = await originalReader(owner, project, scope);
    const attempt = (initializing: boolean) =>
      read(owner, project, async (owned, view) => {
        const snapshot = await metadata(owned, view, project, reader, scope);
        if (
          expected !== undefined &&
          snapshot.commit !== expected &&
          !(initializing && expected === "empty" && snapshot.documents.length === 0 && !snapshot.originals?.length)
        )
          throw new KnowledgeTaskError("conflict");
        view.assertHeld();
        return { value: await work(snapshot, view.assertHeld.bind(view)) };
      });
    let result = await attempt(false);
    if (result === null) {
      if (!initialize || (expected !== undefined && expected !== "empty")) throw new KnowledgeTaskError("conflict");
      await initialize(owner, project);
      result = await attempt(true);
    }
    if (result === null) throw new KnowledgeTaskError("conflict");
    return result.value;
  };
  return {
    withBaseline: baseline,
    async sources(owner, project, offset, commit) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new KnowledgeTaskError("invalidInput");
      const result = await read(owner, project, async (_project, view) => {
        if (commit !== undefined && commit !== view.commit) throw new KnowledgeTaskError("conflict");
        const saved = await savedKnowledgeDocuments(view, project),
          ids = [...saved.documents.keys()].sort();
        if (ids.length > GENERATION_LIMITS.documents) throw new KnowledgeTaskError("budget");
        if (offset > ids.length) throw new KnowledgeTaskError("invalidInput");
        const documents: KnowledgeGenerationSourcePage["documents"] = [],
          headers = new Map<string, DocumentRecord>();
        const header = async (id: string) => {
          let document = headers.get(id);
          if (!document) {
            document = (await readProjectDocumentMetadata(view, id)).document;
            if (document.spaceId !== saved.documents.get(id)?.spaceId) throw new KnowledgeTaskError("conflict");
            headers.set(id, document);
          }
          return document;
        };
        for (const id of ids.slice(offset, offset + 50)) {
          const identity = saved.documents.get(id)!,
            document = await header(id),
            ancestors: string[] = [];
          for (const parent of saved.ancestors(id).reverse()) ancestors.push((await header(parent)).title);
          documents.push({
            ...identity,
            title: document.title,
            breadcrumb: ancestors.join(" / "),
            space: saved.spaces.get(identity.spaceId)!.name,
          });
        }
        return {
          commit: view.commit,
          total: ids.length,
          next: offset + 50 < ids.length ? offset + 50 : null,
          documents,
        };
      });
      if (!result && (offset !== 0 || (commit !== undefined && commit !== "empty")))
        throw new KnowledgeTaskError("conflict");
      return result ?? { commit: "empty", total: 0, next: null, documents: [] };
    },
    async head(owner, project) {
      return (await read(owner, project, async (_project, view) => view.commit)) ?? "empty";
    },
    async snapshot(owner, project, scope) {
      const reader = await originalReader(owner, project, scope);
      return (
        (await read(owner, project, async (owned, view) => metadata(owned, view, project, reader, scope))) ?? {
          commit: "empty",
          documents: [],
        }
      );
    },
    async withSnapshot(owner, project, work, scope) {
      const reader = await originalReader(owner, project, scope);
      const result = await read(owner, project, async (owned, view) =>
        work(await metadata(owned, view, project, reader, scope), view.assertHeld.bind(view)),
      );
      if (result === null) throw new KnowledgeTaskError("conflict");
      return result;
    },
  };
}
