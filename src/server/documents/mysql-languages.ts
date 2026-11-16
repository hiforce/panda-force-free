import type { MySQLDocumentSession } from "./mysql-session.js";
import { randomUUID } from "node:crypto";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";
/** Explicit translation groups retain document identities without inferring equivalent content. */
export class MySQLDocumentLanguages {
  constructor(
    private db: MySQLDocumentSession,
    private requireDocument: (id: string) =>
      | {
          document: DocumentRecord;
        }
      | Promise<{ document: DocumentRecord }>,
  ) {}
  private async group(id: string) {
    return (
      (
        await this.db.one<{
          groupId: string;
        }>("SELECT groupId FROM panda_force_document_languages WHERE documentId=?", [id])
      )?.groupId || null
    );
  }
  async list(id: string) {
    const document = (await this.requireDocument(id)).document;
    const group = await this.group(id);
    if (!group) return [document];
    return await this.db.all<DocumentRecord>(
      "SELECT d.* FROM panda_force_documents d LEFT JOIN panda_force_document_languages l ON l.documentId=d.id WHERE l.groupId=? OR d.id=? ORDER BY d.locale",
      [group, id],
    );
  }
  async link(id: string, otherId: string) {
    return await this.db.transaction(async () => {
      const a = (await this.requireDocument(id)).document,
        b = (await this.requireDocument(otherId)).document;
      if (a.spaceId !== b.spaceId || id === otherId) throw new DocumentError("invalidInput");
      const group = (await this.group(id)) || (await this.group(otherId)) || randomUUID(),
        combined = new Map([...(await this.list(id)), ...(await this.list(otherId))].map((d) => [d.id, d]));
      const locales = new Set<string>();
      for (const record of combined.values()) {
        if (locales.has(record.locale.toLowerCase())) throw new DocumentError("languageConflict", 409);
        locales.add(record.locale.toLowerCase());
      }
      for (const record of combined.values())
        await this.db.run(
          "INSERT INTO panda_force_document_languages (documentId, groupId) VALUES (?,?) ON DUPLICATE KEY UPDATE groupId=VALUES(groupId)",
          [record.id, group],
        );
      return await this.list(id);
    });
  }
  async unlink(id: string) {
    await this.requireDocument(id);
    await this.db.run("DELETE FROM panda_force_document_languages WHERE documentId=?", [id]);
    return await this.list(id);
  }
}
