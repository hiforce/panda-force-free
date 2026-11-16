import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

/** Explicit translation groups retain document identities without inferring equivalent content. */
export class DocumentLanguages {
  constructor(
    private db: Database,
    private requireDocument: (id: string) => { document: DocumentRecord },
  ) {}
  private group(id: string) {
    return (
      this.db.query<{ groupId: string }, [string]>("SELECT groupId FROM document_languages WHERE documentId=?").get(id)
        ?.groupId || null
    );
  }
  list(id: string) {
    const document = this.requireDocument(id).document;
    const group = this.group(id);
    if (!group) return [document];
    return this.db
      .query<DocumentRecord, [string, string]>(
        "SELECT d.* FROM documents d LEFT JOIN document_languages l ON l.documentId=d.id WHERE l.groupId=? OR d.id=? ORDER BY d.locale",
      )
      .all(group, id);
  }
  link(id: string, otherId: string) {
    return this.db
      .transaction(() => {
        const a = this.requireDocument(id).document,
          b = this.requireDocument(otherId).document;
        if (a.spaceId !== b.spaceId || id === otherId) throw new DocumentError("invalidInput");
        const group = this.group(id) || this.group(otherId) || randomUUID(),
          combined = new Map([...this.list(id), ...this.list(otherId)].map((d) => [d.id, d]));
        const locales = new Set<string>();
        for (const record of combined.values()) {
          if (locales.has(record.locale.toLowerCase())) throw new DocumentError("languageConflict", 409);
          locales.add(record.locale.toLowerCase());
        }
        for (const record of combined.values())
          this.db
            .query(
              "INSERT INTO document_languages (documentId, groupId) VALUES (?,?) ON CONFLICT(documentId) DO UPDATE SET groupId=excluded.groupId",
            )
            .run(record.id, group);
        return this.list(id);
      })
      .immediate();
  }
  unlink(id: string) {
    this.requireDocument(id);
    this.db.query("DELETE FROM document_languages WHERE documentId=?").run(id);
    return this.list(id);
  }
}
