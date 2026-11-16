import type { ProjectContentView } from "../../project-content/read-view.js";
import { savedDocumentSources } from "../../content-sources/documents.js";

/** Preserve historical document-only evidence while sharing the saved-original reader. */
export async function savedKnowledgeDocuments(
  view: ProjectContentView,
  project: string,
  requested?: ReadonlySet<string>,
) {
  const saved = await savedDocumentSources(view, project, requested);
  return {
    ...saved,
    async read(id: string) {
      const { detail, text, sections } = await saved.read(id);
      return {
        detail,
        source: {
          id,
          version: detail.revision.id,
          kind: "asset" as const,
          title: detail.document.title,
          text,
          sections,
        },
      };
    },
  };
}
export type SavedKnowledgeDocuments = Awaited<ReturnType<typeof savedKnowledgeDocuments>>;
