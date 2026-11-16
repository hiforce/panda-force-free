import type { DocumentPage, DocumentRecord } from "../../../shared/documents/contracts.js";
import type { DocumentEditorSnapshot } from "../../../shared/documents/working-copy.js";
import { currentDraftContent } from "../../project-content/drafts/content.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { decodeProjectNavigation } from "../../project-content/navigation-file.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { projectDocumentId } from "../../project-content/paths.js";
import { readProjectManifest } from "../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../project-content/space-read.js";
import { DocumentError } from "../errors.js";
import { documentIdentity, type DocumentFileProjects } from "./projects.js";
import { requireFileDocument } from "./source-access.js";
import type { ProjectSavedDocument } from "../source-port.js";
import { FileSavedQueries, readFileSavedDocument } from "./saved-queries.js";

/** Editor and historical reads extend the saved-only content port without exposing repository internals. */
export class FileDocumentQueries extends FileSavedQueries {
  constructor(private readonly projects: DocumentFileProjects) {
    super(projects);
  }

  async record(projectId: string, documentId: string) {
    return this.projects.view(projectId, async (_project, view) => requireFileDocument(view, projectId, documentId));
  }
  async detail(projectId: string, documentId: string) {
    return this.projects.view(projectId, async (_project, view) => readFileSavedDocument(view, projectId, documentId));
  }
  async editor(projectId: string, documentId: string): Promise<DocumentEditorSnapshot> {
    return this.projects.view(projectId, async (project, view) => {
      const detail = await readFileSavedDocument(view, projectId, documentId),
        { content, ...draft } = await project.drafts.snapshot(view, detail);
      return { saved: detail, working: content ?? currentDraftContent(detail), draft };
    });
  }
  async revision(projectId: string, documentId: string, revisionId: string) {
    documentIdentity(documentId);
    documentIdentity(revisionId);
    return this.projects.view(projectId, async (project, view) => {
      const record = await requireFileDocument(view, projectId, documentId);
      return (await project.documents.selection(view, record, revisionId)).revision;
    });
  }
  async source(projectId: string, documentId: string, revisionId: string): Promise<ProjectSavedDocument> {
    documentIdentity(documentId);
    documentIdentity(revisionId);
    return this.projects.view(projectId, async (project, view) => {
      const document = await requireFileDocument(view, projectId, documentId),
        manifest = await readProjectManifest(view, projectId),
        space = await readSpaceMetadata(view, manifest, document.spaceId),
        selected = await project.documents.selection(view, document, revisionId);
      return { projectId, commit: view.commit, document, revision: selected.revision, engine: space.engine };
    });
  }
  async revisions(projectId: string, documentId: string) {
    documentIdentity(documentId);
    return this.projects.view(projectId, async (project, view) => {
      await requireFileDocument(view, projectId, documentId);
      return project.documents.revisions(documentId, 100, view.commit);
    });
  }
  async list(projectId: string, spaceId: string, search = "", offset = 0): Promise<DocumentPage> {
    documentIdentity(spaceId);
    if (typeof search !== "string" || search.length > 200 || !Number.isSafeInteger(offset) || offset < 0)
      throw new DocumentError("invalidInput");
    return this.projects.view(projectId, async (_project, view) => {
      const manifest = await readProjectManifest(view, projectId);
      if (!manifest.spaceIds.includes(spaceId)) throw new DocumentError("notFound", 404);
      await readSpaceMetadata(view, manifest, spaceId);
      const bytes = await view.read("tree.json"),
        tree = bytes === null ? null : decodeProjectNavigation(bytes);
      if (tree && tree.projectId !== projectId) throw new ProjectContentError("invalidFile");
      const trashed = new Set(tree?.spaces.flatMap((state) => state.trash.map((row) => row.documentId))),
        needle = search.normalize("NFC").toLowerCase(),
        documents: DocumentRecord[] = [];
      for (const path of view.paths) {
        const id = projectDocumentId(path);
        if (id === null || trashed.has(id)) continue;
        const { document } = await readProjectDocumentMetadata(view, id);
        if (
          document.spaceId === spaceId &&
          (!needle || (document.title + "\n" + document.path).normalize("NFC").toLowerCase().includes(needle))
        )
          documents.push(document);
      }
      documents.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id, "en"));
      return {
        documents: documents.slice(offset, offset + 100),
        total: documents.length,
        nextOffset: offset + 100 < documents.length ? offset + 100 : null,
      };
    });
  }
}
