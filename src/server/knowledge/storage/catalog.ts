import type { Database } from "bun:sqlite";
import { stableJson } from "../../../shared/stable-json.js";
import { createHash } from "node:crypto";
const knowledgeValueDigest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
import { admittedKnowledgeReceipt, knowledgeCatalogProjection } from "../../../shared/knowledge/catalog.js";
import type {
  KnowledgeAdmission,
  KnowledgeCatalog,
  KnowledgeCatalogEntry,
  KnowledgeCatalogProjection,
  KnowledgeCatalogSelection,
} from "../catalog/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { knowledgeId } from "../../../shared/knowledge/primitives.js";
interface Row {
  taskId: string;
  owner: string;
  project: string;
  outputDigest: string;
  inputDigest: string;
  result: string;
  storedOutput: string | null;
  projection: string | null;
  digest: string | null;
}
const selection =
  "SELECT t.id taskId,t.owner,t.project,t.outputDigest,t.inputDigest,t.result,c.outputDigest storedOutput,c.projection,c.digest FROM knowledge_tasks t LEFT JOIN knowledge_catalog c ON c.taskId=t.id ";
function admission(row: Row): KnowledgeAdmission {
  return {
    taskId: row.taskId,
    owner: row.owner,
    project: row.project,
    outputDigest: row.outputDigest,
    inputDigest: row.inputDigest,
    receipt: admittedKnowledgeReceipt(JSON.parse(row.result)),
  };
}
function entry(row: Row): KnowledgeCatalogEntry | null {
  if (!row.projection || row.storedOutput !== row.outputDigest) return null;
  try {
    const projection = knowledgeCatalogProjection(JSON.parse(row.projection)),
      accepted = admission(row);
    if (
      knowledgeValueDigest(projection) !== row.digest ||
      projection.taskId !== accepted.taskId ||
      projection.id !== accepted.receipt.id ||
      projection.version !== accepted.receipt.version
    )
      return null;
    return { ...accepted, projection };
  } catch {
    return null;
  }
}
function decodeRows(rows: Row[]): KnowledgeCatalogSelection {
  const entries: KnowledgeCatalogEntry[] = [],
    missing: KnowledgeAdmission[] = [];
  let incomplete = false;
  for (const row of rows) {
    const value = entry(row);
    if (value) entries.push(value);
    else {
      incomplete = true;
      try {
        missing.push(admission(row));
      } catch {}
    }
  }
  return { entries, incomplete, missing };
}
/** The workflow's completed receipt is the authority; a self-hashed knowledge file or projection never grants approval. */
export class KnowledgeCatalogStore implements KnowledgeCatalog {
  constructor(private readonly db: Database) {}
  lookup(owner: string, project: string, taskIds: readonly string[]) {
    if (taskIds.length > 1000) throw new KnowledgeTaskError("budget");
    const query = this.db.query<Row, [string, string, string, string]>(
      selection + "WHERE t.id=? AND t.state='completed' AND t.project=? AND (?!='personal' OR t.owner=?)",
    );
    return this.db
      .transaction(() =>
        decodeRows(
          [...new Set(taskIds.map(knowledgeId))].flatMap((id) => {
            const row = query.get(id, project, project, owner);
            return row ? [row] : [];
          }),
        ),
      )
      .deferred();
  }
  page(owner: string, project: string, after = "", limit = 128) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || (after && knowledgeId(after) !== after))
      throw new KnowledgeTaskError("invalidInput");
    const rows = this.db
      .query<Row, [string, string, string, string, number]>(
        selection +
          "WHERE t.state='completed' AND t.project=? AND (?!='personal' OR t.owner=?) AND t.id>? ORDER BY t.id LIMIT ?",
      )
      .all(project, project, owner, after, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { ...decodeRows(rows), next: hasMore ? rows.at(-1)!.taskId : null, scanned: rows.length };
  }
  list(owner: string, project: string) {
    return this.db
      .transaction(() => {
        const entries: KnowledgeCatalogEntry[] = [],
          missing: KnowledgeAdmission[] = [];
        let incomplete = false,
          after = "",
          scanned = 0;
        for (;;) {
          const page = this.page(owner, project, after);
          entries.push(...page.entries);
          missing.push(...page.missing);
          incomplete ||= page.incomplete;
          // Invalid admissions must also count toward the bounded full-snapshot budget.
          scanned += page.scanned;
          if (scanned > 10000) throw new KnowledgeTaskError("budget");
          if (!page.next) break;
          after = page.next;
        }
        return { entries, incomplete, missing };
      })
      .deferred();
  }
  candidates(after: string, onlyMissing = false) {
    const rows = this.db
        .query<Row, [string]>(
          selection +
            "WHERE t.state='completed' AND t.id>? " +
            (onlyMissing ? "AND (c.taskId IS NULL OR c.outputDigest!=t.outputDigest) " : "") +
            "ORDER BY t.id LIMIT 16",
        )
        .all(after),
      admissions: KnowledgeAdmission[] = [];
    let invalid = 0;
    for (const row of rows) {
      try {
        admissions.push(admission(row));
      } catch {
        invalid++;
      }
    }
    return { admissions, invalid, cursor: rows.at(-1)?.taskId ?? "" };
  }
  current(accepted: KnowledgeAdmission) {
    const row = this.db
      .query<Row, [string, string, string, string, string]>(
        selection +
          "WHERE t.state='completed' AND t.id=? AND t.owner=? AND t.project=? AND t.outputDigest=? AND t.inputDigest=?",
      )
      .get(accepted.taskId, accepted.owner, accepted.project, accepted.outputDigest, accepted.inputDigest);
    try {
      if (!row || stableJson(admission(row).receipt) !== stableJson(accepted.receipt)) return null;
    } catch {
      return null;
    }
    return entry(row);
  }
  save(accepted: KnowledgeAdmission, value: KnowledgeCatalogProjection) {
    const projection = knowledgeCatalogProjection(value);
    if (
      projection.taskId !== accepted.taskId ||
      projection.id !== accepted.receipt.id ||
      projection.version !== accepted.receipt.version
    )
      throw new KnowledgeTaskError("conflict");
    return this.db
      .transaction(() => {
        const row = this.db
          .query<Row, [string, string, string, string, string]>(
            selection +
              "WHERE t.state='completed' AND t.id=? AND t.owner=? AND t.project=? AND t.outputDigest=? AND t.inputDigest=?",
          )
          .get(accepted.taskId, accepted.owner, accepted.project, accepted.outputDigest, accepted.inputDigest);
        if (!row || stableJson(admission(row).receipt) !== stableJson(accepted.receipt)) return false;
        this.db
          .query(
            "INSERT INTO knowledge_catalog VALUES(?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET outputDigest=excluded.outputDigest,projection=excluded.projection,digest=excluded.digest",
          )
          .run(accepted.taskId, accepted.outputDigest, stableJson(projection), knowledgeValueDigest(projection));
        return true;
      })
      .immediate();
  }
}
