import type { DocumentTreeTrashPage, ProjectDocumentTree } from "../../../../shared/documents/navigation.js";
import type { ProjectNavigationTrash } from "../../../project-content/navigation-file.js";
import { readProjectDocumentMetadata } from "../../../project-content/document-metadata.js";
import { DocumentError } from "../../errors.js";
import { editorInput } from "../commands.js";
import { documentIdentity, type DocumentFileProjects } from "../projects.js";
import { readFileNavigation, readFileTree } from "./read.js";

function cursorInput(value: string, projectId: string) {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw Error("Invalid cursor");
    const input = editorInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [
      "schema",
      "projectId",
      "commit",
      "deletedAt",
      "documentId",
    ]);
    if (
      input.schema !== 1 ||
      input.projectId !== projectId ||
      typeof input.commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(input.commit) ||
      !Number.isSafeInteger(input.deletedAt) ||
      Number(input.deletedAt) < 0
    )
      throw Error("Invalid cursor");
    return { commit: input.commit, deletedAt: Number(input.deletedAt), documentId: documentIdentity(input.documentId) };
  } catch {
    throw new DocumentError("invalidInput");
  }
}
function trashGroups(rows: ProjectNavigationTrash[]) {
  const known = new Map(rows.map((row) => [row.documentId, row])),
    counts = new Map(rows.map((row) => [row.documentId, 1]));
  for (const row of rows) {
    let parent = row.parentId === null ? undefined : known.get(row.parentId);
    while (row.operationId !== null && parent && parent.operationId === row.operationId) {
      counts.set(parent.documentId, counts.get(parent.documentId)! + 1);
      parent = parent.parentId === null ? undefined : known.get(parent.parentId);
    }
  }
  return {
    counts,
    roots: rows.filter(
      (row) =>
        row.operationId === null || row.parentId === null || known.get(row.parentId)?.operationId !== row.operationId,
    ),
  };
}

/** Tree and trash queries inspect bounded metadata; they neither initialize repositories nor load source bodies. */
export class FileTreeQueries {
  constructor(private readonly projects: Pick<DocumentFileProjects, "ifPresent">) {}
  async tree(projectId: string): Promise<ProjectDocumentTree> {
    return (
      (await this.projects.ifPresent(
        projectId,
        async (_project, view) => (await readFileTree(view, projectId)).tree,
      )) ?? { projectId, version: 0, nodes: [] }
    );
  }
  async trashPage(projectId: string, cursor?: string): Promise<DocumentTreeTrashPage> {
    const after = cursor === undefined ? null : cursorInput(cursor, projectId),
      result = await this.projects.ifPresent(projectId, async (_project, view) => {
        if (after && after.commit !== view.commit) throw new DocumentError("navigationConflict", 409);
        const { space, state } = await readFileNavigation(view, projectId),
          { roots, counts } = trashGroups(state?.trash ?? []),
          selected = roots
            .filter(
              (row) =>
                !after ||
                row.deletedAt < after.deletedAt ||
                (row.deletedAt === after.deletedAt && row.documentId > after.documentId),
            )
            .sort(
              (a, b) =>
                b.deletedAt - a.deletedAt || (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0),
            ),
          documents: DocumentTreeTrashPage["documents"] = [];
        for (const row of selected.slice(0, 200)) {
          const { document } = await readProjectDocumentMetadata(view, row.documentId);
          if (document.spaceId !== space?.id) throw new DocumentError("unavailable", 503);
          documents.push({ document, deletedAt: row.deletedAt, subtreeCount: counts.get(row.documentId)! });
        }
        const last = documents.at(-1);
        return {
          documents,
          nextCursor:
            selected.length > 200 && last
              ? Buffer.from(
                  JSON.stringify({
                    schema: 1,
                    projectId,
                    commit: view.commit,
                    deletedAt: last.deletedAt,
                    documentId: last.document.id,
                  }),
                ).toString("base64url")
              : null,
        };
      });
    if (result === null && after) throw new DocumentError("navigationConflict", 409);
    return result ?? { documents: [], nextCursor: null };
  }
}
