import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { MySQLProjectDocumentNavigation } from "../../documents/navigation/mysql-service.js";
import type { ProjectDocumentNavigation } from "../../documents/navigation/service.js";

export type CreationDocumentPort = Pick<FileDocumentNavigation, "tree" | "createFromSource" | "appendFromSource">;

/** Generated documents use the same project backend as manual creation, retaining existing document identities. */
export function projectCreationDocuments(
  files: (project: string) => boolean | Promise<boolean>,
  current: CreationDocumentPort,
  existing:
    | Pick<ProjectDocumentNavigation, "tree" | "createFromSource" | "appendFromSource">
    | Pick<MySQLProjectDocumentNavigation, "tree" | "createFromSource" | "appendFromSource">,
  authorize: (owner: string, project: string) => void | Promise<void>,
): CreationDocumentPort {
  return {
    tree: async (project) => ((await files(project)) ? current.tree(project) : existing.tree(project)),
    createFromSource: async (actor, input, source) => {
      const project = projectId(input);
      await authorize(actor, project);
      return (await files(project))
        ? current.createFromSource(actor, input, source)
        : existing.createFromSource(actor, input, source, () => authorize(actor, project));
    },
    appendFromSource: async (actor, input, source) => {
      const project = projectId(input);
      await authorize(actor, project);
      return (await files(project))
        ? current.appendFromSource(actor, input, source)
        : existing.appendFromSource(actor, input, source, () => authorize(actor, project));
    },
  };
}

function projectId(input: unknown): string {
  return input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof (input as Record<string, unknown>).projectId === "string"
    ? (input as { projectId: string }).projectId
    : "";
}
