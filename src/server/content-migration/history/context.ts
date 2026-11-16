import type { ReadQueries } from "../../../shared/storage/read-queries.js";
import { createHash } from "node:crypto";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { ProjectContentError } from "../../project-content/errors.js";
import type { LegacyHistoryBlocker, LegacyHistoryRecord } from "./contracts.js";

export const historyHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const invalidHistory = (): never => {
  throw new ProjectContentError("invalidFile");
};
export function historyJson<T>(text: unknown): T {
  if (typeof text !== "string") return invalidHistory();
  try {
    return JSON.parse(text) as T;
  } catch {
    return invalidHistory();
  }
}

/** One already-open backup owns lifecycle. Facets only read rows and register compact archive identities. */
export class LegacyHistoryContext {
  readonly records: LegacyHistoryRecord[] = [];
  readonly blockers: LegacyHistoryBlocker[] = [];
  readonly schemas: Record<string, number> = {};
  readonly tables: ReadonlySet<string>;
  readonly documents: ReadonlyMap<string, DocumentRecord>;
  readonly variants = new Map<string, { documentId: string; revisionId: string; digest: string }>();
  readonly builds = new Set<string>();
  readonly plans = new Map<string, { ownerId: string; fingerprint: string; kind: string }>();
  readonly documentFilter = "SELECT d.id FROM documents d JOIN document_spaces s ON s.id=d.spaceId WHERE s.projectId=?";
  readonly spaceFilter = "SELECT id FROM document_spaces WHERE projectId=?";
  private readonly identities = new Set<string>();
  constructor(
    readonly db: ReadQueries,
    readonly projectId: string,
    records: DocumentRecord[],
  ) {
    this.documents = new Map(records.map((record) => [record.id, record]));
    this.tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
  }
  domain(marker: string, maximum: number, tables: readonly (readonly [string, number])[]): number {
    if (!this.tables.has(marker)) {
      if (tables.some(([table]) => this.tables.has(table))) return invalidHistory();
      this.schemas[marker] = 0;
      return 0;
    }
    const row = this.db.query<{ version: number }, []>(`SELECT version FROM ${marker} WHERE id=1`).get();
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1) return invalidHistory();
    if (row.version > maximum) throw new ProjectContentError("unsupportedSchema");
    for (const [table, minimum] of tables)
      if (minimum <= row.version !== this.tables.has(table)) return invalidHistory();
    this.schemas[marker] = row.version;
    return row.version;
  }
  archive(table: string, key: string, row: object): void {
    const identity = table + ":" + key;
    if (!key || this.identities.has(identity)) return invalidHistory();
    const encoded = stableJson(row);
    this.identities.add(identity);
    this.records.push({ table, key, digest: historyHash(encoded), bytes: Buffer.byteLength(encoded) });
  }
  block(kind: LegacyHistoryBlocker["kind"], id: string, state: string): void {
    this.blockers.push({ kind, id, state });
  }
  legacyScope(table: string, column: string): void {
    if (this.db.query(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(this.projectId))
      throw new ProjectContentError("conflict");
  }
  source(ref: {
    documentId: string;
    revisionId: string;
    sourceHash: string;
    version?: number;
    projectId?: string;
    commit?: string;
  }): void {
    if (
      !ref ||
      ref.projectId !== undefined ||
      ref.commit !== undefined ||
      typeof ref.sourceHash !== "string" ||
      !this.documents.has(ref.documentId)
    )
      return invalidHistory();
    const revision = this.db
      .query<{ number: number; contentHash: string }, [string, string]>(
        "SELECT number,contentHash FROM document_revisions WHERE documentId=? AND id=?",
      )
      .get(ref.documentId, ref.revisionId);
    if (
      !revision ||
      ref.sourceHash !== revision.contentHash ||
      (ref.version !== undefined && ref.version !== revision.number)
    )
      return invalidHistory();
  }
  children(
    table: string,
    parent: string,
    identities: Iterable<string>,
    key: (row: Record<string, unknown>) => string,
  ): void {
    for (const id of [...identities].sort())
      for (const row of this.db
        .query<Record<string, unknown>, [string]>(`SELECT * FROM ${table} WHERE ${parent}=? ORDER BY rowid`)
        .iterate(id))
        this.archive(table, key(row), row);
  }
}
