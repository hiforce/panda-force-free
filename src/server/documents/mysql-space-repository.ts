import type { MySQLDocumentSession } from "./mysql-session.js";
import { randomUUID } from "node:crypto";
import type { DocumentSpace, DocumentSpaceInput } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";
export class MySQLSpaceRepository {
  constructor(private db: MySQLDocumentSession) {}
  async list(projectId: string): Promise<DocumentSpace[]> {
    return await this.db.all<DocumentSpace>(
      "SELECT * FROM panda_force_document_spaces WHERE projectId=? AND id NOT IN (SELECT spaceId FROM panda_force_project_document_libraries) ORDER BY createdAt,id",
      [projectId],
    );
  }
  async get(id: string): Promise<DocumentSpace> {
    const row = await this.db.one<DocumentSpace>("SELECT * FROM panda_force_document_spaces WHERE id=?", [id]);
    if (!row) throw new DocumentError("notFound", 404);
    return row;
  }
  async create(input: DocumentSpaceInput, sourceRoot: string, id: string = randomUUID()): Promise<DocumentSpace> {
    return await this.db.transaction(async () => {
      if (
        await this.db.one("SELECT id FROM panda_force_document_spaces WHERE projectId=? AND code=?", [
          input.projectId,
          input.code,
        ])
      )
        throw new DocumentError("duplicate", 409);
      const now = Date.now();
      await this.db.run("INSERT INTO panda_force_document_spaces VALUES (?,?,?,?,?,?,?,?,?,1,?,?)", [
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
      ]);
      return await this.get(id);
    });
  }
  async setTheme(id: string, theme: string, version: number): Promise<DocumentSpace> {
    return await this.db.transaction(async () => {
      if ((await this.get(id)).version !== version) throw new DocumentError("spaceConflict", 409);
      await this.db.run("UPDATE panda_force_document_spaces SET theme=?,version=version+1,updatedAt=? WHERE id=?", [
        theme,
        Date.now(),
        id,
      ]);
      return await this.get(id);
    });
  }
  async rename(id: string, name: string, version: number): Promise<DocumentSpace> {
    return await this.db.transaction(async () => {
      if ((await this.get(id)).version !== version) throw new DocumentError("conflict", 409);
      await this.db.run("UPDATE panda_force_document_spaces SET name=?,version=version+1,updatedAt=? WHERE id=?", [
        name,
        Date.now(),
        id,
      ]);
      return await this.get(id);
    });
  }
}
