import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { EditorialProposal, EditorialSummaryBase } from "../../../shared/editorial/contracts.js";
import { editorialSummary } from "../../../shared/editorial/summary.js";
import { EditorialError } from "../errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface HistoryRow {
  id: string;
  payload: string;
  digest: string;
  createdAt: number;
  sequence: number;
  applied: number;
}
function cursor(value: string | null): [number, number] {
  if (value === null) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  try {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((n) => !Number.isSafeInteger(n) || n < 0))
      throw Error();
    return parsed as [number, number];
  } catch {
    throw new EditorialError("invalidInput");
  }
}
/** A small independent projection keeps pagination off the immutable proposal and receipt blobs. */
export class EditorialHistoryRepository {
  constructor(private db: Database) {}
  insert(owner: string, proposal: EditorialProposal) {
    const payload = JSON.stringify(editorialSummary(proposal));
    if (Buffer.byteLength(payload) > 8192) throw new EditorialError("invalidInput");
    this.db
      .query(
        `INSERT INTO editorial_history(id,owner,documentId,payload,digest,createdAt,sequence)
      SELECT id,owner,documentId,?,?,createdAt,rowid FROM editorial_proposals WHERE id=? AND owner=?`,
      )
      .run(payload, digest(payload), proposal.id, owner);
    // Schema3 backfills run before the scope column exists; only new explicitly scoped reviews need this projection.
    if (proposal.source.projectId !== undefined)
      this.db
        .query("UPDATE editorial_history SET sourceProjectId=? WHERE id=?")
        .run(proposal.source.projectId, proposal.id);
  }
  page(owner: string, documentId: string, before: string | null, projectId?: string) {
    const [at, sequence] = cursor(before),
      rows = this.db
        .query<HistoryRow, [string, string, string | null, number, number, number]>(
          `SELECT h.id,h.payload,h.digest,h.createdAt,h.sequence,EXISTS(SELECT 1 FROM editorial_applications a WHERE a.proposalId=h.id) AS applied
      FROM editorial_history h WHERE h.owner=? AND h.documentId=? AND h.sourceProjectId IS ? AND (h.createdAt<? OR (h.createdAt=? AND h.sequence<?))
      ORDER BY h.createdAt DESC,h.sequence DESC LIMIT 51`,
        )
        .all(owner, documentId, projectId ?? null, at, at, sequence);
    const selected = rows.slice(0, 50),
      last = selected.at(-1);
    return {
      reviews: selected.map((row) => {
        if (digest(row.payload) !== row.digest) throw new EditorialError("unavailable", 503);
        const summary = JSON.parse(row.payload) as EditorialSummaryBase;
        if (summary.id !== row.id || summary.source.documentId !== documentId || summary.source.projectId !== projectId)
          throw new EditorialError("unavailable", 503);
        return { ...summary, applied: !!row.applied };
      }),
      nextCursor:
        rows.length > 50 && last
          ? Buffer.from(JSON.stringify([last.createdAt, last.sequence])).toString("base64url")
          : null,
    };
  }
}
