import type { DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { MySQLDocumentSession } from "../mysql-session.js";
import { DocumentError } from "../errors.js";
import { assertOwnershipTransition, ownershipRecordText, sqlOwnershipRecord } from "./record.js";

export class MySQLDocumentOwnershipRepository {
  constructor(private readonly db: MySQLDocumentSession) {}
  async get(spaceId: string, documentId: string) {
    const row = await this.db.one<{ record: string; projectId: string }>(
      "SELECT o.record,s.projectId FROM panda_force_document_ownership_records o JOIN panda_force_document_spaces s ON s.id=o.spaceId WHERE o.spaceId=? AND o.documentId=?",
      [spaceId, documentId],
    );
    return row ? sqlOwnershipRecord(row.record, documentId, row.projectId) : null;
  }
  async forDocument(documentId: string) {
    const row = await this.db.one<{ record: string; projectId: string }>(
      "SELECT o.record,s.projectId FROM panda_force_document_ownership_records o JOIN panda_force_documents d ON d.id=o.documentId AND d.spaceId=o.spaceId JOIN panda_force_document_spaces s ON s.id=o.spaceId WHERE d.id=?",
      [documentId],
    );
    return row ? sqlOwnershipRecord(row.record, documentId, row.projectId) : null;
  }
  async put(spaceId: string, input: DocumentOwnershipRecord, expected: DocumentOwnershipRecord | null) {
    const record = structuredClone(input),
      prior = structuredClone(expected);
    return this.db.transaction(async () => {
      const before = await this.get(spaceId, record.documentId);
      if (stableJson(before) !== stableJson(prior)) throw new DocumentError("conflict", 409);
      assertOwnershipTransition(before, record);
      const project = await this.db.one<{ projectId: string }>(
        "SELECT projectId FROM panda_force_document_spaces WHERE id=?",
        [spaceId],
      );
      if (!project) throw new DocumentError("notFound", 404);
      const text = ownershipRecordText(record);
      sqlOwnershipRecord(text, record.documentId, project.projectId);
      await this.db.run(
        "INSERT INTO panda_force_document_ownership_records(spaceId,documentId,record) VALUES(?,?,?) ON DUPLICATE KEY UPDATE record=VALUES(record)",
        [spaceId, record.documentId, text],
      );
      return structuredClone(record);
    });
  }
}
