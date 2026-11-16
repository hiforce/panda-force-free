import type { Database } from "bun:sqlite";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { SpaceRepository } from "./space-repository.js";

/** A project owns one Markdown authoring library; publication spaces reference documents without copying them. */
export class ProjectLibraryRepository {
  constructor(
    private db: Database,
    private spaces: SpaceRepository,
  ) {}
  library(projectId: string): DocumentSpace | null {
    const value = this.db
      .query<{ spaceId: string }, [string]>("SELECT spaceId FROM project_document_libraries WHERE projectId=?")
      .get(projectId);
    return value ? this.spaces.get(value.spaceId) : null;
  }
  ensure(projectId: string, locale: string, id: string, sourceRoot: string) {
    return this.db
      .transaction(() => {
        const existing = this.library(projectId);
        if (existing) return existing;
        const space = this.spaces.create(
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
        this.db.query("INSERT INTO project_document_libraries VALUES (?,?)").run(projectId, space.id);
        return space;
      })
      .immediate();
  }
}
