import type { MySQLDocumentSession } from "./mysql-session.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { MySQLSpaceRepository } from "./mysql-space-repository.js";
/** A project owns one Markdown authoring library; publication spaces reference documents without copying them. */
export class MySQLProjectLibraryRepository {
  constructor(
    private db: MySQLDocumentSession,
    private spaces: MySQLSpaceRepository,
  ) {}
  async library(projectId: string): Promise<DocumentSpace | null> {
    const value = await this.db.one<{
      spaceId: string;
    }>("SELECT spaceId FROM panda_force_project_document_libraries WHERE projectId=?", [projectId]);
    return value ? await this.spaces.get(value.spaceId) : null;
  }
  async ensure(projectId: string, locale: string, id: string, sourceRoot: string) {
    return await this.db.transaction(async () => {
      const existing = await this.library(projectId);
      if (existing) return existing;
      const space = await this.spaces.create(
        {
          projectId,
          code: "__documents__",
          name: "Project documents",
          engine: "markdown",
          theme: "default",
          sourceMode: "managed",
          locale,
        },
        sourceRoot,
        id,
      );
      await this.db.run("INSERT INTO panda_force_project_document_libraries VALUES (?,?)", [projectId, space.id]);
      return space;
    });
  }
}
