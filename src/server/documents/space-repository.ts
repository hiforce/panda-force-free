import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { DocumentSpace, DocumentSpaceInput } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

export class SpaceRepository {
  constructor(private db: Database) {}
  list(projectId: string): DocumentSpace[] {
    return this.db
      .query<DocumentSpace, [string]>(
        "SELECT * FROM document_spaces WHERE projectId=? AND id NOT IN (SELECT spaceId FROM project_document_libraries) ORDER BY createdAt,id",
      )
      .all(projectId);
  }
  get(id: string): DocumentSpace {
    const row = this.db.query<DocumentSpace, [string]>("SELECT * FROM document_spaces WHERE id=?").get(id);
    if (!row) throw new DocumentError("notFound", 404);
    return row;
  }
  create(input: DocumentSpaceInput, sourceRoot: string, id: string = randomUUID()): DocumentSpace {
    return this.db
      .transaction(() => {
        if (
          this.db.query("SELECT id FROM document_spaces WHERE projectId=? AND code=?").get(input.projectId, input.code)
        )
          throw new DocumentError("duplicate", 409);
        const now = Date.now();
        this.db
          .query("INSERT INTO document_spaces VALUES (?,?,?,?,?,?,?,?,?,1,?,?)")
          .run(
            id,
            input.projectId,
            input.code,
            input.name,
            input.engine,
            input.theme,
            input.sourceMode,
            sourceRoot,
            input.locale,
            now,
            now,
          );
        return this.get(id);
      })
      .immediate();
  }
  setTheme(id: string, theme: string, version: number): DocumentSpace {
    return this.db
      .transaction(() => {
        if (this.get(id).version !== version) throw new DocumentError("spaceConflict", 409);
        this.db
          .query("UPDATE document_spaces SET theme=?,version=version+1,updatedAt=? WHERE id=?")
          .run(theme, Date.now(), id);
        return this.get(id);
      })
      .immediate();
  }
  rename(id: string, name: string, version: number): DocumentSpace {
    return this.db
      .transaction(() => {
        if (this.get(id).version !== version) throw new DocumentError("conflict", 409);
        this.db
          .query("UPDATE document_spaces SET name=?,version=version+1,updatedAt=? WHERE id=?")
          .run(name, Date.now(), id);
        return this.get(id);
      })
      .immediate();
  }
}
