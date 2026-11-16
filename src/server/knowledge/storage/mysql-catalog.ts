import type { MySQLMetadataContext } from "./mysql-context.js";

import { stableJson } from "../../../shared/stable-json.js";
import { createHash } from "node:crypto";
const knowledgeValueDigest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
import { admittedKnowledgeReceipt, knowledgeCatalogProjection } from "../../../shared/knowledge/catalog.js";
import type {
  KnowledgeAdmission,
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
  "SELECT t.id taskId,t.owner,t.project,t.outputDigest,t.inputDigest,t.result,c.outputDigest storedOutput,c.projection,c.digest FROM panda_force_knowledge_tasks t LEFT JOIN panda_force_knowledge_catalog c ON c.taskId=t.id ";
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
export class MySQLKnowledgeCatalogStore {
  constructor(private readonly db: MySQLMetadataContext) {}
  async lookup(owner: string, project: string, taskIds: readonly string[]) {
    return await this.db.atomic(async () => {
      if (taskIds.length > 1000) throw new KnowledgeTaskError("budget");
      const ids = [...new Set(taskIds.map(knowledgeId))];
      if (!ids.length) return decodeRows([]);
      const rows = await this.db.all<Row>(
        selection +
          `WHERE t.id IN (${ids.map(() => "?").join(",")}) AND t.state='completed' AND t.project=? AND (?!='personal' OR t.owner=?)`,
        [...ids, project, project, owner],
      );
      const found = new Map(rows.map((row) => [row.taskId, row]));
      // Preserve caller order and the receipt/projection integrity checks.
      return decodeRows(ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : [])));
    });
  }
  async page(owner: string, project: string, after = "", limit = 128) {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || (after && knowledgeId(after) !== after))
        throw new KnowledgeTaskError("invalidInput");
      const rows = await this.db.all<Row>(
        selection +
          "WHERE t.state='completed' AND t.project=? AND (?!='personal' OR t.owner=?) AND t.id>? ORDER BY t.id LIMIT ?",
        [project, project, owner, after, limit + 1],
      );
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return { ...decodeRows(rows), next: hasMore ? rows.at(-1)!.taskId : null, scanned: rows.length };
    });
  }
  async list(owner: string, project: string) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const entries: KnowledgeCatalogEntry[] = [],
          missing: KnowledgeAdmission[] = [];
        let incomplete = false,
          after = "",
          scanned = 0;
        for (;;) {
          const page = await this.page(owner, project, after);
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
      });
    });
  }
  async candidates(after: string, onlyMissing = false) {
    return await this.db.atomic(async () => {
      const rows = await this.db.all<Row>(
          selection +
            "WHERE t.state='completed' AND t.id>? " +
            (onlyMissing ? "AND (c.taskId IS NULL OR c.outputDigest!=t.outputDigest) " : "") +
            "ORDER BY t.id LIMIT 16",
          [after],
        ),
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
    });
  }
  async current(accepted: KnowledgeAdmission) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<Row>(
        selection +
          "WHERE t.state='completed' AND t.id=? AND t.owner=? AND t.project=? AND t.outputDigest=? AND t.inputDigest=?",
        [accepted.taskId, accepted.owner, accepted.project, accepted.outputDigest, accepted.inputDigest],
      );
      try {
        if (!row || stableJson(admission(row).receipt) !== stableJson(accepted.receipt)) return null;
      } catch {
        return null;
      }
      return entry(row);
    });
  }
  async save(accepted: KnowledgeAdmission, value: KnowledgeCatalogProjection) {
    return await this.db.atomic(async () => {
      const projection = knowledgeCatalogProjection(value);
      if (
        projection.taskId !== accepted.taskId ||
        projection.id !== accepted.receipt.id ||
        projection.version !== accepted.receipt.version
      )
        throw new KnowledgeTaskError("conflict");
      return await this.db.atomic(async () => {
        const row = await this.db.one<Row>(
          selection +
            "WHERE t.state='completed' AND t.id=? AND t.owner=? AND t.project=? AND t.outputDigest=? AND t.inputDigest=?",
          [accepted.taskId, accepted.owner, accepted.project, accepted.outputDigest, accepted.inputDigest],
        );
        if (!row || stableJson(admission(row).receipt) !== stableJson(accepted.receipt)) return false;
        await this.db.execute(
          "INSERT INTO panda_force_knowledge_catalog VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE outputDigest=VALUES(outputDigest),projection=VALUES(projection),digest=VALUES(digest)",
          [accepted.taskId, accepted.outputDigest, stableJson(projection), knowledgeValueDigest(projection)],
        );
        return true;
      });
    });
  }
}
