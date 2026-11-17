import type { Database } from "bun:sqlite";
import type { DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../errors.js";
import { assertOwnershipTransition, ownershipRecordText, sqlOwnershipRecord } from "./record.js";

export class DocumentOwnershipRepository {
  constructor(private readonly db: Database) {}
  get(spaceId: string, documentId: string) {
    const row = this.db
      .query<{ record: string; projectId: string }, [string, string]>(
        "SELECT o.record,s.projectId FROM document_ownership_records o JOIN document_spaces s ON s.id=o.spaceId WHERE o.spaceId=? AND o.documentId=?",
      )
      .get(spaceId, documentId);
    return row ? sqlOwnershipRecord(row.record, documentId, row.projectId) : null;
  }
  forDocument(documentId: string) {
    const row = this.db
      .query<{ record: string; projectId: string }, [string]>(
        "SELECT o.record,s.projectId FROM document_ownership_records o JOIN documents d ON d.id=o.documentId AND d.spaceId=o.spaceId JOIN document_spaces s ON s.id=o.spaceId WHERE d.id=?",
      )
      .get(documentId);
    return row ? sqlOwnershipRecord(row.record, documentId, row.projectId) : null;
  }
  put(spaceId: string, input: DocumentOwnershipRecord, expected: DocumentOwnershipRecord | null) {
    const record = structuredClone(input),
      prior = structuredClone(expected);
    return this.db
      .transaction(() => {
        const before = this.get(spaceId, record.documentId);
        if (stableJson(before) !== stableJson(prior)) throw new DocumentError("conflict", 409);
        assertOwnershipTransition(before, record);
        const project = this.db
          .query<{ projectId: string }, [string]>("SELECT projectId FROM document_spaces WHERE id=?")
          .get(spaceId);
        if (!project) throw new DocumentError("notFound", 404);
        const text = ownershipRecordText(record);
        sqlOwnershipRecord(text, record.documentId, project.projectId);
        this.db
          .query(
            "INSERT INTO document_ownership_records(spaceId,documentId,record) VALUES(?,?,?) ON CONFLICT(spaceId,documentId) DO UPDATE SET record=excluded.record",
          )
          .run(spaceId, record.documentId, text);
        return structuredClone(record);
      })
      .immediate();
  }
}
