import type { Database } from "bun:sqlite";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { ProjectContentError } from "../errors.js";
import { PROJECT_CONTENT_LIMITS } from "../limits.js";

/** Facet readers receive only read queries; the owning standalone backup keeps the snapshot and lifecycle. */
export class LegacyMetadataContext {
  readonly tables: ReadonlySet<string>;
  private bytes = 0;
  constructor(
    private readonly db: Database,
    readonly projectId: string,
    readonly documents: ReadonlyMap<string, DocumentRecord>,
  ) {
    this.tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
  }
  rows<T>(sql: string, values: string[] = []): T[] {
    const result: T[] = [];
    for (const row of this.db.query<T, string[]>(sql).iterate(...values)) {
      try {
        this.bytes += Buffer.byteLength(JSON.stringify(row));
      } catch {
        throw new ProjectContentError("invalidFile");
      }
      if (this.bytes > PROJECT_CONTENT_LIMITS.operationBytes) throw new ProjectContentError("invalidFile");
      result.push(row);
    }
    return result;
  }
  requireTables(names: readonly string[]): void {
    if (names.some((name) => !this.tables.has(name))) throw new ProjectContentError("invalidFile");
  }
  requireDocument(id: string, spaceId?: string): DocumentRecord {
    const doc = this.documents.get(id);
    if (!doc || (spaceId !== undefined && doc.spaceId !== spaceId)) throw new ProjectContentError("invalidFile");
    return doc;
  }
}
export function legacyMetadataJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ProjectContentError("invalidFile");
  }
}
